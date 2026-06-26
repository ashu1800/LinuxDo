// Background Service Worker - Main orchestration
// DOM-based operations: navigates tabs, content script extracts/interacts

importScripts('lib/storage.js', 'lib/scheduler.js', 'lib/deepseek-client.js', 'lib/topic-filter.js');

const CHECK_INTERVAL = 5; // minutes
const NOTIFICATION_INTERVAL = 10; // minutes
const MAX_TOPICS_PER_CYCLE = 5;
const MAX_COMMENTS_PER_CYCLE = 3;
const CLEANUP_INTERVAL = 60; // minutes
const CLEANUP_AGE_DAYS = 7;
const MAX_REPLY_HISTORY = 200;
const BACKOFF_BASE_MS = 60000;
const BACKOFF_MAX_MS = 900000;
const NAV_TIMEOUT = 30000;
const TASK_LOCK_TTL_MS = 120000;
const MAX_NOTIFICATION_ATTEMPTS = 3;
const REPLY_WAKE_ALARM = 'wakeAfterReplyInterval';

// ========== Current Operation State (in-memory, for popup display) ==========

let currentOperation = {
  type: 'idle',       // idle | navigating | reading | evaluating | posting | waiting | paused
  description: '',
  topicTitle: '',
  progress: 0,
  startTime: 0
};

let operationQueue = []; // [{ topicId, title, action, status }]

async function persistOperation(op) {
  try {
    await chrome.storage.local.set({ persistedOp: { ...op, persistedAt: Date.now() } });
  } catch (_) {}
}

function setOperation(type, description, topicTitle, progress) {
  currentOperation = { type, description, topicTitle, progress, startTime: Date.now() };
  persistOperation(currentOperation);
}

function clearOperation() {
  currentOperation = { type: 'idle', description: '', topicTitle: '', progress: 0, startTime: 0 };
  persistOperation(currentOperation);
}

function clearAll() {
  clearOperation();
  operationQueue = [];
}

async function acquireTaskLock(taskName) {
  const now = Date.now();
  let acquired = false;
  let reason = '已有任务运行中';
  await updateState(state => {
    const lock = state.taskLock;
    if (lock && lock.expiresAt && lock.expiresAt > now) {
      reason = `已有任务运行中: ${lock.taskName}`;
      return state;
    }
    state.taskLock = { taskName, startTime: now, expiresAt: now + TASK_LOCK_TTL_MS };
    acquired = true;
    return state;
  });
  return { acquired, reason };
}

async function releaseTaskLock(taskName) {
  await updateState(state => {
    if (state.taskLock?.taskName === taskName || !taskName) {
      state.taskLock = null;
    }
    return state;
  });
}

function getReplyDelay(settings) {
  return Math.max(0, Number(settings.minReplyInterval || 0) * 60000);
}

async function setNextReplyAllowedAt(settings) {
  const nextReplyAllowedAt = Date.now() + getReplyDelay(settings);
  await updateState(state => {
    state.nextReplyAllowedAt = nextReplyAllowedAt;
    return state;
  });
  await scheduleReplyWakeAlarm(nextReplyAllowedAt);
  return nextReplyAllowedAt;
}

async function scheduleReplyWakeAlarm(nextReplyAllowedAt) {
  if (!nextReplyAllowedAt || nextReplyAllowedAt <= Date.now()) return;
  await chrome.alarms.create(REPLY_WAKE_ALARM, { when: nextReplyAllowedAt });
}

// ========== Navigation-Based Operations ==========

let requestCounter = 0;
const pendingRequests = {};

/**
 * Listen for results from content script (after DOM operations)
 */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.requestId && pendingRequests[msg.requestId]) {
    const entry = pendingRequests[msg.requestId];
    cleanupRequest(msg.requestId);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.data);
  }
});

/**
 * Navigate the tab to a URL and execute a DOM operation on the content script
 * Returns the data extracted or result of the operation
 */
async function navigateAndAct(tabId, url, type, extra = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++requestCounter;
    const timeout = setTimeout(() => {
      cleanupRequest(requestId);
      reject(new Error(`操作超时: ${type} (${NAV_TIMEOUT / 1000}s)`));
    }, NAV_TIMEOUT);

    pendingRequests[requestId] = { resolve, reject, timeout, onUpdated: null, retryTimer: null };

    // Wait for page to finish loading
    const onUpdated = (changedTabId, changeInfo) => {
      if (changedTabId !== tabId) return;
      if (changeInfo.status !== 'complete') return;

      const entry = pendingRequests[requestId];
      if (!entry) return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      entry.onUpdated = null;

      // Give Discourse JS time to initialize
      entry.retryTimer = setTimeout(async () => {
        const activeEntry = pendingRequests[requestId];
        if (!activeEntry) return;
        activeEntry.retryTimer = null;
        try {
          const result = await trySendExecute(tabId, requestId, type, extra);
          // Content script will send result back via chrome.runtime.sendMessage
          if (result && result.error) {
            cleanupRequest(requestId);
            reject(new Error(result.error));
          }
        } catch (err) {
          // Content script might not be injected yet, retry once
          const retryEntry = pendingRequests[requestId];
          if (!retryEntry) return;
          retryEntry.retryTimer = setTimeout(async () => {
            const finalEntry = pendingRequests[requestId];
            if (!finalEntry) return;
            finalEntry.retryTimer = null;
            try {
              await trySendExecute(tabId, requestId, type, extra);
            } catch (e2) {
              cleanupRequest(requestId);
              reject(new Error(`Content script 不可达: ${e2.message}`));
            }
          }, 3000);
        }
      }, 2000);
    };

    pendingRequests[requestId].onUpdated = onUpdated;
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        cleanupRequest(requestId);
        reject(new Error(`导航失败: ${chrome.runtime.lastError.message}`));
      }
    });
  });
}

function cleanupRequest(requestId) {
  const entry = pendingRequests[requestId];
  if (!entry) return;
  clearTimeout(entry.timeout);
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  if (entry.onUpdated) chrome.tabs.onUpdated.removeListener(entry.onUpdated);
  delete pendingRequests[requestId];
}

async function trySendExecute(tabId, requestId, type, extra) {
  return chrome.tabs.sendMessage(tabId, {
    action: 'execute',
    type,
    requestId,
    ...extra
  });
}

// ========== Initialization ==========

chrome.runtime.onInstalled.addListener(async () => {
  await initStorage();
  await chrome.alarms.create('checkNewTopics', { periodInMinutes: CHECK_INTERVAL });
  await chrome.alarms.create('checkNotifications', { periodInMinutes: NOTIFICATION_INTERVAL });
  await chrome.alarms.create('cleanup', { periodInMinutes: CLEANUP_INTERVAL });
  console.log('[LinuxDoHelper] Installed and alarms created');
});

chrome.runtime.onStartup.addListener(async () => {
  await initStorage();
  console.log('[LinuxDoHelper] Service worker started');
});

// ========== Alarm Handlers ==========

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'checkNewTopics':
      await handleNewTopicsCheck();
      break;
    case 'checkNotifications':
      await handleNotificationCheck();
      break;
    case 'cleanup':
      await handleCleanup();
      break;
    case REPLY_WAKE_ALARM:
      await handleNewTopicsCheck();
      await handleNotificationCheck();
      break;
  }
});

// ========== New Topics Check ==========

async function handleNewTopicsCheck() {
  const { settings, state } = await getStorage();
  const proceedCheck = shouldProceed(settings, state);
  if (!proceedCheck.allowed) return { ok: false, reason: proceedCheck.reason };

  const lock = await acquireTaskLock('topics');
  if (!lock.acquired) return { ok: false, reason: lock.reason };

  try {
    const tab = await findLinuxDoTab();
    if (!tab) {
      await addActivity({ type: 'info', status: 'info', message: '未检测到 linux.do 标签页，跳过本轮' });
      return { ok: false, reason: '未检测到 linux.do 标签页' };
    }

    setOperation('navigating', '正在导航到最新帖子页面...', '', 5);

    // Read latest topics via DOM navigation
    const result = await navigateAndAct(tab.id, 'https://linux.do/latest', 'getLatestTopics');

    const topics = result.topic_list?.topics || [];
    const tracked = state.trackedTopics || {};

    // Filter to unprocessed, non-pinned topics
    let newTopics = topics.filter(t =>
      !tracked[t.id] &&
      !t.pinned &&
      t.posts_count > 0
    );

    // Apply selectedCategories filter if configured
    if (settings.selectedCategories && settings.selectedCategories.length > 0) {
      newTopics = newTopics.filter(t =>
        settings.selectedCategories.includes(t.category_id)
      );
    }

    if (newTopics.length === 0) {
      clearAll();
      console.log('[LinuxDoHelper] No new topics found');
      return { ok: true, reason: '无新帖' };
    }

    // Set up operation queue
    operationQueue = newTopics.slice(0, MAX_TOPICS_PER_CYCLE).map(t => ({
      topicId: t.id, title: t.title, action: 'reply', status: 'pending'
    }));

    console.log(`[LinuxDoHelper] Found ${newTopics.length} new topics, processing up to ${MAX_TOPICS_PER_CYCLE}`);

    for (let qi = 0; qi < operationQueue.length; qi++) {
      const topic = newTopics[qi];
      operationQueue[qi].status = 'processing';

      const rateCheck = canReplyNow(state, settings);
      if (!rateCheck.allowed) {
        operationQueue[qi].status = 'pending';
        setOperation('waiting', rateCheck.reason, '', 0);
        await updateState(s => {
          s.lastQueue = operationQueue.slice();
          s.replyCountThisHour = state.replyCountThisHour;
          s.replyHourStart = state.replyHourStart;
          return s;
        });
        console.log(`[LinuxDoHelper] Rate limited: ${rateCheck.reason}`);
        break;
      }

      let replyPosted = false;
      tracked[topic.id] = { visited: true, time: Date.now(), replied: false };

      // Read topic detail + check commentability in one navigation
      setOperation('reading', '正在读取帖子详情...', topic.title, 20);
      const detail = await navigateAndAct(tab.id, `https://linux.do/t/${topic.id}`, 'getTopicDetail');

      // `detail.commentable` is returned from extractTopicDetail()
      if (detail && detail.commentable) {
        // Generate reply with safety check (skip worth-replying gate)
        setOperation('evaluating', '正在 AI 生成回复...', topic.title, 55);
        const firstPost = detail.post_stream?.posts?.[0];
        const topicData = {
          id: topic.id,
          title: detail.title || topic.title,
          excerpt: firstPost?.plain || firstPost?.cooked || '',
          replyCount: topic.posts_count || 0
        };
        const replyResult = await evaluateAndReply(topicData, settings.apiKey, chat);

        if (replyResult.action === 'reply') {
          setOperation('posting', '正在提交回复...', topic.title, 80);
          const postResult = await navigateAndAct(tab.id, `https://linux.do/t/${topic.id}`, 'postReply', {
            content: replyResult.content
          });

          if (postResult.success) {
            tracked[topic.id].replied = true;
            tracked[topic.id].replyTime = Date.now();
            state.lastReplyTime = Date.now();
            state.replyCountThisHour++;
            state.replyHistory.push({
              topicId: topic.id, title: topic.title,
              content: replyResult.content, time: Date.now(), type: 'topic'
            });

            await addActivity({
              type: 'reply', topicId: topic.id, title: topic.title,
              status: 'success', message: '回复成功'
            });
            operationQueue[qi].status = 'completed';
            replyPosted = true;
            console.log(`[LinuxDoHelper] Replied to topic #${topic.id}: ${topic.title}`);
          } else {
            operationQueue[qi].status = 'discarded';
            await addActivity({
              type: 'discard', topicId: topic.id, title: topic.title,
              status: 'warning', message: '回复提交失败'
            });
          }
        } else if (replyResult.action === 'skip') {
          operationQueue[qi].status = 'skipped';
          await addActivity({
            type: 'skip', topicId: topic.id, title: topic.title,
            status: 'info', message: replyResult.reason || '不值得回复'
          });
        } else {
          operationQueue[qi].status = 'discarded';
          await addActivity({
            type: 'discard', topicId: topic.id, title: topic.title,
            status: 'warning', message: replyResult.reason || '回复生成失败'
          });
        }

        // Wait reply interval after successful reply
        if (replyPosted) {
          setOperation('waiting', `等待回复间隔 ${settings.minReplyInterval} 分钟...`, '', 95);
          await setNextReplyAllowedAt(settings);
          break;
        }
      } else {
        // Topic not commentable — just mark as browsed
        operationQueue[qi].status = 'skipped';
        await addActivity({
          type: 'skip', topicId: topic.id, title: topic.title,
          status: 'info', message: detail?.commentableReason || '话题不可评论，已标记已浏览'
        });
      }

      await updateState(s => {
        s.trackedTopics = tracked;
        s.lastReplyTime = state.lastReplyTime;
        s.replyCountThisHour = state.replyCountThisHour;
        s.replyHourStart = state.replyHourStart;
        s.replyHistory = state.replyHistory;
        return s;
      });
    }

    clearOperation();

    await updateState(s => {
      s.lastQueue = operationQueue.slice();
      s.trackedTopics = tracked;
      s.errorCount = 0;
      s.lastErrorTime = 0;
      return s;
    });
    return { ok: true };

  } catch (err) {
    clearAll();
    console.error('[LinuxDoHelper] Topic check error:', err);
    await addActivity({ type: 'error', status: 'error', message: `帖子检查异常: ${err.message}` });
    await updateState(s => {
      s.errorCount = (s.errorCount || 0) + 1;
      s.lastErrorTime = Date.now();
      s.lastQueue = [{ title: `检查异常: ${err.message}`, status: 'error', action: '', topicId: 0 }];
      return s;
    });
    return { ok: false, reason: err.message };
  } finally {
    await releaseTaskLock('topics');
  }
}

// ========== Notification / Comment Reply Check ==========

async function handleNotificationCheck() {
  const { settings, state } = await getStorage();
  if (!state || state.isPaused) return { ok: false, reason: '已暂停' };
  if (!settings.autoReplyComments) return { ok: false, reason: '未开启评论回复' };
  if (!isWithinWorkingHours(settings.schedule)) return { ok: false, reason: '不在工作时段' };
  if (state.nextReplyAllowedAt && Date.now() < state.nextReplyAllowedAt) {
    return { ok: false, reason: '回复间隔未到' };
  }

  const rateCheck = canReplyNow(state, settings);
  if (!rateCheck.allowed) return { ok: false, reason: rateCheck.reason };

  const lock = await acquireTaskLock('notifications');
  if (!lock.acquired) return { ok: false, reason: lock.reason };

  try {
    const tab = await findLinuxDoTab();
    if (!tab) {
      return { ok: false, reason: '未检测到 linux.do 标签页' };
    }

    setOperation('navigating', '正在读取通知...', '', 5);

    // Read notifications via DOM navigation
    const notifResult = await navigateAndAct(tab.id, 'https://linux.do/notifications', 'getNotifications');
    const notifications = notifResult.notifications || [];
    const trackedNotifs = state.trackedNotifications || {};

    const relevantNotifs = notifications.filter(n =>
      n.notification_type === 6 &&
      (!trackedNotifs[n.id] || (trackedNotifs[n.id].status === 'failed' && (trackedNotifs[n.id].attempts || 0) < MAX_NOTIFICATION_ATTEMPTS))
    );

    if (relevantNotifs.length === 0) { clearAll(); return { ok: true, reason: '无新通知' }; }

    // Set up queue
    operationQueue = relevantNotifs.slice(0, MAX_COMMENTS_PER_CYCLE).map(n => ({
      topicId: n.topic_id,
      title: (n.data?.original_text || `通知 #${n.topic_id}`).slice(0, 40),
      action: 'comment_reply', status: 'pending'
    }));

    console.log(`[LinuxDoHelper] Found ${relevantNotifs.length} new reply notifications`);

    for (let qi = 0; qi < operationQueue.length; qi++) {
      const notif = relevantNotifs[qi];
      operationQueue[qi].status = 'processing';
      const previous = trackedNotifs[notif.id] || {};
      const attempts = (previous.attempts || 0) + 1;

      try {
        setOperation('reading', '正在读取帖子详情...', operationQueue[qi].title, 20);
        const topicDetail = await navigateAndAct(tab.id, `https://linux.do/t/${notif.topic_id}`, 'getTopicDetail');

        const parentPost = topicDetail.post_stream?.posts?.find(
          p => p.post_number === notif.post_number
        );
        if (!parentPost) {
          operationQueue[qi].status = 'skipped';
          trackedNotifs[notif.id] = { time: Date.now(), status: 'skipped', reason: '找不到父评论', attempts };
          await addActivity({
            type: 'skip', topicId: notif.topic_id,
            status: 'info', message: '通知父评论不存在，已跳过'
          });
          continue;
        }

        const result = await evaluateCommentReply(
          topicDetail.title || '',
          parentPost.plain || parentPost.cooked || '',
          notif.data?.original_text || '',
          settings.apiKey,
          chat
        );

        if (result.action === 'reply') {
          setOperation('posting', '正在提交评论回复...', operationQueue[qi].title, 80);

          const postResult = await navigateAndAct(tab.id, `https://linux.do/t/${notif.topic_id}`, 'postReply', {
            content: result.content,
            replyToPostNumber: notif.post_number
          });

          setOperation('posting', '正在提交评论回复...', operationQueue[qi].title, 90);

          if (postResult.success) {
            state.lastReplyTime = Date.now();
            state.replyCountThisHour++;
            state.replyHistory.push({
              topicId: notif.topic_id, content: result.content, time: Date.now(), type: 'comment'
            });

            await addActivity({
              type: 'comment_reply', topicId: notif.topic_id,
              status: 'success', message: '评论回复成功'
            });
            operationQueue[qi].status = 'completed';
            trackedNotifs[notif.id] = { time: Date.now(), status: 'replied', attempts };
            await updateState(s => {
              s.trackedNotifications = trackedNotifs;
              s.lastReplyTime = state.lastReplyTime;
              s.replyCountThisHour = state.replyCountThisHour;
              s.replyHourStart = state.replyHourStart;
              s.replyHistory = state.replyHistory;
              s.lastQueue = operationQueue.slice();
              return s;
            });
            await setNextReplyAllowedAt(settings);
            break;
          }

          operationQueue[qi].status = attempts >= MAX_NOTIFICATION_ATTEMPTS ? 'discarded' : 'pending';
          trackedNotifs[notif.id] = {
            time: Date.now(),
            status: attempts >= MAX_NOTIFICATION_ATTEMPTS ? 'failed' : 'failed',
            reason: '回复提交失败',
            attempts
          };
        } else {
          operationQueue[qi].status = 'discarded';
          trackedNotifs[notif.id] = {
            time: Date.now(),
            status: 'discarded',
            reason: result.reason || '评论回复生成失败',
            attempts
          };
          await addActivity({
            type: 'discard', topicId: notif.topic_id,
            status: 'warning', message: result.reason || '评论回复生成失败'
          });
        }
      } catch (itemErr) {
        operationQueue[qi].status = attempts >= MAX_NOTIFICATION_ATTEMPTS ? 'discarded' : 'pending';
        trackedNotifs[notif.id] = {
          time: Date.now(),
          status: attempts >= MAX_NOTIFICATION_ATTEMPTS ? 'failed' : 'failed',
          reason: itemErr.message,
          attempts
        };
        await addActivity({
          type: 'error', topicId: notif.topic_id,
          status: 'error', message: `通知处理失败: ${itemErr.message}`
        });
      }

      await updateState(s => {
        s.trackedNotifications = trackedNotifs;
        s.lastReplyTime = state.lastReplyTime;
        s.replyCountThisHour = state.replyCountThisHour;
        s.replyHourStart = state.replyHourStart;
        s.replyHistory = state.replyHistory;
        s.lastQueue = operationQueue.slice();
        return s;
      });
    }

    clearOperation();

    await updateState(s => {
      s.trackedNotifications = trackedNotifs;
      s.lastQueue = operationQueue.slice();
      return s;
    });
    return { ok: true };

  } catch (err) {
    clearAll();
    console.error('[LinuxDoHelper] Notification check error:', err);
    await updateState(s => {
      s.errorCount = (s.errorCount || 0) + 1;
      s.lastErrorTime = Date.now();
      s.lastQueue = [{ title: `检查异常: ${err.message}`, status: 'error', action: '', topicId: 0 }];
      return s;
    });
    return { ok: false, reason: err.message };
  } finally {
    await releaseTaskLock('notifications');
  }
}

// ========== Helpers ==========

async function handleCleanup() {
  try {
    const { state } = await getStorage();
    const now = Date.now();
    const maxAge = CLEANUP_AGE_DAYS * 86400000;
    let changed = false;

    if (state.trackedTopics) {
      for (const [id, entry] of Object.entries(state.trackedTopics)) {
        if (now - (entry.time || 0) > maxAge) {
          delete state.trackedTopics[id];
          changed = true;
        }
      }
    }

    if (state.trackedNotifications) {
      for (const [id, entry] of Object.entries(state.trackedNotifications)) {
        const entryTime = entry && typeof entry === 'object' ? entry.time : 0;
        if (now - entryTime > maxAge) {
          delete state.trackedNotifications[id];
          changed = true;
        }
      }
    }

    if (state.replyHistory && state.replyHistory.length > MAX_REPLY_HISTORY) {
      state.replyHistory = state.replyHistory.slice(0, MAX_REPLY_HISTORY);
      changed = true;
    }

    if (changed) await setState(state);
  } catch (err) {
    console.error('[LinuxDoHelper] Cleanup error:', err);
  }
}

function shouldProceed(settings, state) {
  if (state.isPaused) return { allowed: false, reason: '已暂停' };
  if (!settings.apiKey) {
    console.log('[LinuxDoHelper] API Key not configured');
    return { allowed: false, reason: 'API Key 未配置' };
  }
  if (!isWithinWorkingHours(settings.schedule)) return { allowed: false, reason: '不在工作时段' };

  if (state.nextReplyAllowedAt && Date.now() < state.nextReplyAllowedAt) {
    return { allowed: false, reason: '回复间隔未到' };
  }

  if (state.errorCount > 0 && state.lastErrorTime) {
    const backoffMs = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, state.errorCount - 1),
      BACKOFF_MAX_MS
    );
    if (Date.now() - state.lastErrorTime < backoffMs) return { allowed: false, reason: '错误退避中' };
  }

  return { allowed: true, reason: '' };
}

async function findLinuxDoTab() {
  const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
  if (tabs.length === 0) return null;
  return tabs.find(t => t.active) || tabs[0];
}

// ========== Popup Communication ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const asyncHandler = async () => {
    switch (request.action) {
      case 'getStatus': {
        const { settings, state, activityLog } = await getStorage();
        const opResult = await chrome.storage.local.get(['persistedOp']);
        const persistedOp = opResult.persistedOp;
        const scheduleStatus = getScheduleStatus(settings.schedule);
        const proceedCheck = shouldProceed(settings, state);
        const activeLock = state.taskLock && state.taskLock.expiresAt > Date.now() ? state.taskLock : null;

        // Use in-memory operation if active, otherwise show last known state
        const opToShow = currentOperation.type !== 'idle'
          ? currentOperation
          : (persistedOp && (Date.now() - persistedOp.persistedAt < 60000)
            ? persistedOp
            : currentOperation);

        return {
          isPaused: state.isPaused,
          isWorking: scheduleStatus.working,
          scheduleLabel: scheduleStatus.label,
          apiKeyConfigured: !!settings.apiKey,
          tabOpen: !!(await findLinuxDoTab()),
          stats: computeStats(state, activityLog),
          scheduleStatus,
          currentOp: opToShow,
          queue: operationQueue,
          lastQueue: state.lastQueue || [],
          taskLocked: !!activeLock,
          nextReplyAllowedAt: state.nextReplyAllowedAt || 0,
          blockedReason: activeLock ? `已有任务运行中: ${activeLock.taskName}` : (proceedCheck.allowed ? '' : proceedCheck.reason)
        };
      }

      case 'pause':
        setOperation('paused', '插件已暂停', '', 100);
        await setState({ isPaused: true });
        return { ok: true };

      case 'resume':
        clearAll();
        await setState({ isPaused: false });
        return { ok: true };

      case 'runNow':
        return await handleNewTopicsCheck();

      case 'getSettings': {
        return await getSettings();
      }

      case 'saveSettings':
        await setSettings(request.settings);
        return { ok: true };

      case 'getActivityLog': {
        const log = await getActivityLog();
        return log.slice(0, 50);
      }

      case 'getCategories': {
        const tab = await findLinuxDoTab();
        if (!tab) return { error: '请先打开 linux.do' };
        const lock = await acquireTaskLock('categories');
        if (!lock.acquired) return { error: lock.reason };
        try {
          const result = await navigateAndAct(tab.id, 'https://linux.do/categories', 'getCategories');
          return result;
        } catch (err) {
          return { error: err.message };
        } finally {
          await releaseTaskLock('categories');
        }
      }

      case 'resetState':
        await resetState();
        return { ok: true };

      default:
        return { error: `Unknown action: ${request.action}` };
    }
  };

  asyncHandler().then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

function computeStats(state, activityLog) {
  const stats = { processed: 0, replied: 0, skipped: 0, discarded: 0, commentReplies: 0, errors: 0 };
  if (activityLog) {
    for (const entry of activityLog) {
      if (entry.type === 'reply') stats.replied++;
      else if (entry.type === 'skip') stats.skipped++;
      else if (entry.type === 'discard') stats.discarded++;
      else if (entry.type === 'comment_reply') stats.commentReplies++;
      else if (entry.type === 'error') stats.errors++;
    }
  }
  if (state.trackedTopics) stats.processed = Object.keys(state.trackedTopics).length;
  return stats;
}
