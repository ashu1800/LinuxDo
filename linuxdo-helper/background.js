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

// ========== Current Operation State (in-memory, for popup display) ==========

let currentOperation = {
  type: 'idle',       // idle | navigating | reading | evaluating | posting | waiting | paused
  description: '',
  topicTitle: '',
  progress: 0,
  startTime: 0
};

let operationQueue = []; // [{ topicId, title, action, status }]

function setOperation(type, description, topicTitle, progress) {
  currentOperation = { type, description, topicTitle, progress, startTime: Date.now() };
}

function clearOperation() {
  currentOperation = { type: 'idle', description: '', topicTitle: '', progress: 0, startTime: 0 };
}

function clearAll() {
  clearOperation();
  operationQueue = [];
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
    clearTimeout(entry.timeout);
    delete pendingRequests[msg.requestId];
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

    pendingRequests[requestId] = { resolve, reject, timeout };

    // Navigate the tab
    chrome.tabs.update(tabId, { url });

    // Wait for page to finish loading
    const onUpdated = (changedTabId, changeInfo) => {
      if (changedTabId !== tabId) return;
      if (changeInfo.status !== 'complete') return;

      chrome.tabs.onUpdated.removeListener(onUpdated);

      // Give Discourse JS time to initialize
      setTimeout(async () => {
        try {
          const result = await trySendExecute(tabId, requestId, type, extra);
          // Content script will send result back via chrome.runtime.sendMessage
          if (result && result.error) {
            cleanupRequest(requestId);
            reject(new Error(result.error));
          }
        } catch (err) {
          // Content script might not be injected yet, retry once
          setTimeout(async () => {
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

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function cleanupRequest(requestId) {
  if (pendingRequests[requestId]) {
    clearTimeout(pendingRequests[requestId].timeout);
    delete pendingRequests[requestId];
  }
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
  }
});

// ========== New Topics Check ==========

async function handleNewTopicsCheck() {
  const { settings, state } = await getStorage();
  if (!shouldProceed(settings, state)) return;

  const tab = await findLinuxDoTab();
  if (!tab) {
    await addActivity({ type: 'info', status: 'info', message: '未检测到 linux.do 标签页，跳过本轮' });
    return;
  }

  try {
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
      return;
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
        setOperation('waiting', rateCheck.reason, '', 0);
        console.log(`[LinuxDoHelper] Rate limited: ${rateCheck.reason}`);
        break;
      }

      tracked[topic.id] = { processed: true, time: Date.now(), replied: false };

      // Read topic detail via DOM navigation
      setOperation('reading', '正在读取帖子详情...', topic.title, 20);
      const detail = await navigateAndAct(tab.id, `https://linux.do/t/${topic.id}`, 'getTopicDetail');

      const firstPost = detail.post_stream?.posts?.[0];
      const topicData = {
        id: topic.id,
        title: detail.title || topic.title,
        excerpt: firstPost?.plain || firstPost?.cooked || '',
        replyCount: topic.posts_count || 0
      };

      // Evaluate with DeepSeek and generate reply
      setOperation('evaluating', '正在 AI 分析帖子...', topic.title, 40);
      const evalResult = await evaluateAndReply(topicData, settings.apiKey, chat);

      if (evalResult.action === 'reply') {
        setOperation('posting', '正在提交回复...', topic.title, 80);
        // Post reply via DOM navigation (includes navigation + fill + submit)
        const postResult = await navigateAndAct(tab.id, `https://linux.do/t/${topic.id}`, 'postReply', {
          content: evalResult.content
        });

        if (postResult.success) {
          tracked[topic.id].replied = true;
          tracked[topic.id].replyTime = Date.now();
          state.lastReplyTime = Date.now();
          state.replyCountThisHour++;
          state.replyHistory.push({
            topicId: topic.id, title: topic.title,
            content: evalResult.content, time: Date.now(), type: 'topic'
          });

          await addActivity({
            type: 'reply', topicId: topic.id, title: topic.title,
            status: 'success', message: '回复成功'
          });
          operationQueue[qi].status = 'completed';
          console.log(`[LinuxDoHelper] Replied to topic #${topic.id}: ${topic.title}`);
        }
      } else if (evalResult.action === 'skip') {
        operationQueue[qi].status = 'skipped';
        await addActivity({
          type: 'skip', topicId: topic.id, title: topic.title,
          status: 'info', message: evalResult.reason || ''
        });
      } else {
        operationQueue[qi].status = 'discarded';
        await addActivity({
          type: 'discard', topicId: topic.id, title: topic.title,
          status: 'warning', message: evalResult.reason || ''
        });
      }

      state.trackedTopics = tracked;
      await setState(state);

      if (evalResult.action === 'reply') {
        setOperation('waiting', `等待回复间隔 ${settings.minReplyInterval} 分钟...`, '', 95);
        await sleep(settings.minReplyInterval * 60000);
      }
    }

    clearOperation();

    state.trackedTopics = tracked;
    state.errorCount = 0;
    state.lastErrorTime = 0;
    await setState(state);

  } catch (err) {
    clearAll();
    console.error('[LinuxDoHelper] Topic check error:', err);
    await addActivity({ type: 'error', status: 'error', message: `帖子检查异常: ${err.message}` });
    const s = await getState();
    await setState({ errorCount: (s.errorCount || 0) + 1, lastErrorTime: Date.now() });
  }
}

// ========== Notification / Comment Reply Check ==========

async function handleNotificationCheck() {
  const { settings, state } = await getStorage();
  if (!state || state.isPaused) return;
  if (!settings.autoReplyComments) return;
  if (!isWithinWorkingHours(settings.schedule)) return;

  const rateCheck = canReplyNow(state, settings);
  if (!rateCheck.allowed) return;

  const tab = await findLinuxDoTab();
  if (!tab) return;

  try {
    setOperation('navigating', '正在读取通知...', '', 5);

    // Read notifications via DOM navigation
    const notifResult = await navigateAndAct(tab.id, 'https://linux.do/notifications', 'getNotifications');
    const notifications = notifResult.notifications || [];
    const trackedNotifs = state.trackedNotifications || {};

    const relevantNotifs = notifications.filter(n =>
      n.notification_type === 6 && !trackedNotifs[n.id]
    );

    if (relevantNotifs.length === 0) { clearAll(); return; }

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

      setOperation('reading', '正在读取帖子详情...', operationQueue[qi].title, 20);
      const topicDetail = await navigateAndAct(tab.id, `https://linux.do/t/${notif.topic_id}`, 'getTopicDetail');

      const parentPost = topicDetail.post_stream?.posts?.find(
        p => p.post_number === notif.post_number
      );
      if (!parentPost) continue;

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
        }
      } else {
        operationQueue[qi].status = 'discarded';
      }

      // Only mark as tracked after successful processing
      trackedNotifs[notif.id] = { time: Date.now() };

      state.trackedNotifications = trackedNotifs;
      await setState(state);

      if (result.action === 'reply') {
        setOperation('waiting', `等待回复间隔 ${settings.minReplyInterval} 分钟...`, '', 95);
        await sleep(settings.minReplyInterval * 60000);
      }
    }

    clearOperation();

    state.trackedNotifications = trackedNotifs;
    await setState(state);

  } catch (err) {
    clearAll();
    console.error('[LinuxDoHelper] Notification check error:', err);
    await setState({ errorCount: (state.errorCount || 0) + 1, lastErrorTime: Date.now() });
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
  if (state.isPaused) return false;
  if (!settings.apiKey) {
    console.log('[LinuxDoHelper] API Key not configured');
    return false;
  }
  if (!isWithinWorkingHours(settings.schedule)) return false;

  if (state.errorCount > 0 && state.lastErrorTime) {
    const backoffMs = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, state.errorCount - 1),
      BACKOFF_MAX_MS
    );
    if (Date.now() - state.lastErrorTime < backoffMs) return false;
  }

  return true;
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
        const scheduleStatus = getScheduleStatus(settings.schedule);
        return {
          isPaused: state.isPaused,
          isWorking: scheduleStatus.working,
          scheduleLabel: scheduleStatus.label,
          apiKeyConfigured: !!settings.apiKey,
          tabOpen: !!(await findLinuxDoTab()),
          stats: computeStats(state, activityLog),
          scheduleStatus,
          currentOp: currentOperation,
          queue: operationQueue
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
        handleNewTopicsCheck();
        return { ok: true };

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
        try {
          const result = await navigateAndAct(tab.id, 'https://linux.do/categories', 'getCategories');
          return result;
        } catch (err) {
          return { error: err.message };
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