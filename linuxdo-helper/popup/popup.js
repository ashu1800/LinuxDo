// Popup UI - Dashboard and Settings

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LABELS = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };
const FREQ_SETTINGS = {
  conservative: { maxRepliesPerHour: 3, minReplyInterval: 20 },
  moderate: { maxRepliesPerHour: 8, minReplyInterval: 5 },
  aggressive: { maxRepliesPerHour: 15, minReplyInterval: 2 }
};

document.addEventListener('DOMContentLoaded', async () => {
  // Tab switching
  document.getElementById('tabDashboard').addEventListener('click', () => switchTab('dashboard'));
  document.getElementById('tabSettings').addEventListener('click', () => switchTab('settings'));

  // Initialize
  await refreshStatus();
  await refreshOperation();
  await refreshActivityLog();
  await loadSettings();

  // Event handlers
  document.getElementById('btnPause').addEventListener('click', togglePause);
  document.getElementById('btnRunNow').addEventListener('click', runNow);
  document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);
  document.getElementById('btnRefreshCategories').addEventListener('click', refreshCategories);

  // Auto-refresh dashboard every 10s
  setInterval(() => {
    if (!document.getElementById('dashboard').classList.contains('hidden')) {
      refreshStatus();
      refreshActivityLog();
    }
  }, 10000);

  // Auto-refresh operation status every 2s (always, even when on settings tab)
  setInterval(refreshOperation, 2000);
});

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('settings').classList.add('hidden');

  if (tab === 'dashboard') {
    document.getElementById('tabDashboard').classList.add('active');
    document.getElementById('tabDashboard').setAttribute('aria-selected', 'true');
    document.getElementById('dashboard').classList.remove('hidden');
    refreshStatus();
    refreshActivityLog();
  } else {
    document.getElementById('tabSettings').classList.add('active');
    document.getElementById('tabSettings').setAttribute('aria-selected', 'true');
    document.getElementById('settings').classList.remove('hidden');
    loadSettings();
  }
}

// ========== Status ==========

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    updateStatusUI(status);
  } catch (err) {
    console.error('Status error:', err);
  }
}

function updateStatusUI(status) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  if (!status) {
    dot.className = 'dot gray';
    text.textContent = '无法连接';
    return;
  }

  if (status.isPaused) {
    dot.className = 'dot yellow';
    text.textContent = '已暂停';
  } else if (status.taskLocked) {
    dot.className = 'dot green';
    text.textContent = status.blockedReason || '任务运行中';
  } else if (status.blockedReason) {
    dot.className = 'dot yellow';
    text.textContent = status.blockedReason;
  } else if (!status.apiKeyConfigured) {
    dot.className = 'dot red';
    text.textContent = '未配置 API Key';
  } else if (!status.tabOpen) {
    dot.className = 'dot yellow';
    text.textContent = '等待 linux.do 标签页';
  } else if (status.isWorking) {
    dot.className = 'dot green';
    text.textContent = '运行中';
  } else {
    dot.className = 'dot gray';
    text.textContent = status.scheduleLabel || '休息中';
  }

  // Update pause button
  const btn = document.getElementById('btnPause');
  btn.textContent = status.isPaused ? '恢复运行' : '暂停';

  // Update stats
  const stats = status.stats || {};
  document.getElementById('statReplied').textContent = stats.replied || 0;
  document.getElementById('statSkipped').textContent = stats.skipped || 0;
  document.getElementById('statDiscarded').textContent = stats.discarded || 0;
  document.getElementById('statCommentReplies').textContent = stats.commentReplies || 0;
}

// ========== Current Operation & Queue ==========

async function refreshOperation() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (!status) return;
    renderCurrentOp(status.currentOp);
    renderQueue(status.queue, status.lastQueue);
  } catch (err) {
    // Silently fail - operation display is not critical
  }
}

function renderCurrentOp(op) {
  const card = document.getElementById('currentOperation');
  if (!card) return;

  // Always show the card — never hide it
  card.classList.remove('hidden');

  if (!op || op.type === 'idle') {
    document.getElementById('opIcon').textContent = '⏸';
    document.getElementById('opIcon').className = 'op-icon idle';
    document.getElementById('opTitle').textContent = '空闲中';
    document.getElementById('opDesc').textContent = '等待定时检查或手动触发';
    document.getElementById('opTopicTitle').textContent = '';
    document.getElementById('opProgressFill').style.width = '0%';
    return;
  }

  const iconMap = {
    navigating: '\u25B6',
    reading: '\u2139',
    evaluating: '\u2699',
    posting: '\u2709',
    waiting: '\u23F3',
    paused: '\u23F8'
  };

  const icon = document.getElementById('opIcon');
  icon.textContent = iconMap[op.type] || '\u25B6';
  icon.className = 'op-icon ' + op.type;

  document.getElementById('opTitle').textContent = getOpTitle(op.type);
  document.getElementById('opDesc').textContent = op.description || '';
  document.getElementById('opTopicTitle').textContent = op.topicTitle ? '帖子: ' + op.topicTitle : '';
  document.getElementById('opProgressFill').style.width = Math.min(op.progress || 0, 100) + '%';
}

function getOpTitle(type) {
  const titles = {
    navigating: '导航中',
    reading: '读取页面',
    evaluating: 'AI 分析中',
    posting: '提交回复',
    waiting: '等待中',
    paused: '已暂停'
  };
  return titles[type] || '操作中';
}

function renderQueue(queue, lastQueue) {
  const section = document.getElementById('operationQueue');
  const list = document.getElementById('queueList');
  if (!section || !list) return;

  // Always show the section \u2014 never hide it
  section.classList.remove('hidden');

  const items = (queue && queue.length > 0) ? queue : (lastQueue || []);
  const isHistory = !queue || queue.length === 0;

  const heading = section.querySelector('h3');
  if (heading) {
    if (items.length === 0) {
      heading.textContent = '\u64CD\u4F5C\u8BB0\u5F55';
    } else {
      heading.textContent = isHistory ? '\u4E0A\u6B21\u68C0\u67E5\u7ED3\u679C' : '\u5F85\u64CD\u4F5C\u961F\u5217';
    }
  }

  if (items.length === 0) {
    list.innerHTML = '<div class="queue-empty">\u6682\u65E0\u8BB0\u5F55\uFF0C\u70B9\u51FB\u300C\u624B\u52A8\u8FD0\u884C\u300D\u5F00\u59CB\u68C0\u67E5</div>';
    return;
  }

  const iconMap = {
    completed: '\u2705',
    processing: '\u25B6',
    pending: '\u23F3',
    skipped: '\u23ED',
    discarded: '\u26A0',
    error: '\u274C'
  };

  list.innerHTML = items.map(item => `
    <div class="queue-item">
      <span class="status-icon ${item.status}">${iconMap[item.status] || '\u2022'}</span>
      <span class="queue-title">${escapeHtml(item.title)}</span>
    </div>
  `).join('');
}

// ========== Activity Log ==========

async function refreshActivityLog() {
  try {
    const log = await chrome.runtime.sendMessage({ action: 'getActivityLog' });
    const list = document.getElementById('activityList');
    if (!log || log.length === 0) {
      list.innerHTML = '<li style="color:var(--text-muted);padding:8px 0;font-size:12px;">暂无活动记录</li>';
      return;
    }

    list.innerHTML = log.slice(0, 20).map(entry => {
      const icon = getActivityIcon(entry.type, entry.status);
      const time = formatTime(entry.time);
      const msg = entry.title ? `[${entry.title}] ${entry.message}` : entry.message;
      return `
        <li class="activity-item">
          <span class="activity-icon">${icon}</span>
          <div class="activity-body">
            <div class="activity-message">${escapeHtml(msg)}</div>
            <span class="activity-time">${time}</span>
          </div>
        </li>
      `;
    }).join('');
  } catch (err) {
    console.error('Activity log error:', err);
  }
}

function getActivityIcon(type, status) {
  if (status === 'error') return '\u274C';
  switch (type) {
    case 'reply':
    case 'comment_reply': return '\u2705';
    case 'skip': return '\u23ED';
    case 'discard': return '\u26A0';
    case 'info': return '\u2139';
    default: return '\u2022';
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========== Controls ==========

async function togglePause() {
  const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
  const action = status?.isPaused ? 'resume' : 'pause';
  await chrome.runtime.sendMessage({ action });
  await refreshStatus();
}

async function runNow() {
  const btn = document.getElementById('btnRunNow');
  btn.textContent = '运行中...';
  btn.disabled = true;
  const result = await chrome.runtime.sendMessage({ action: 'runNow' });
  if (result && result.ok === false) {
    btn.textContent = '手动运行';
    btn.disabled = false;
    await refreshStatus();
    return;
  }

  // Poll until operation completes or timeout
  const startTime = Date.now();
  const timeout = 120000; // 2 min max
  while (Date.now() - startTime < timeout) {
    await sleep(2000);
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    const activeTypes = ['navigating', 'reading', 'evaluating', 'posting', 'waiting'];
    if (!activeTypes.includes(status?.currentOp?.type)) {
      break;
    }
  }

  btn.textContent = '手动运行';
  btn.disabled = false;
  refreshStatus();
  refreshActivityLog();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== Settings ==========

async function loadSettings() {
  try {
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (!settings) return;

    document.getElementById('inputApiKey').value = settings.apiKey || '';
    document.getElementById('selectFrequency').value = settings.replyFrequency || 'moderate';
    document.getElementById('chkAutoComment').checked = settings.autoReplyComments !== false;

    renderSchedule(settings.schedule);
    renderSelectedCategories(settings.selectedCategories);
  } catch (err) {
    console.error('Load settings error:', err);
  }
}

function renderSchedule(schedule) {
  const container = document.getElementById('scheduleContainer');
  container.innerHTML = '';

  for (const day of DAY_NAMES) {
    const d = schedule?.[day] || { enabled: false, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' };
    const row = document.createElement('div');
    row.className = 'schedule-row';

    const label = document.createElement('label');
    label.textContent = DAY_LABELS[day];
    row.appendChild(label);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.day = day;
    cb.className = 'day-enable';
    cb.checked = d.enabled;
    row.appendChild(cb);

    const startInput = document.createElement('input');
    startInput.type = 'time';
    startInput.dataset.day = day;
    startInput.className = 'day-start';
    startInput.value = d.start || '09:00';
    row.appendChild(startInput);

    const dash1 = document.createElement('span');
    dash1.style.cssText = 'color:var(--text-muted)';
    dash1.textContent = '-';
    row.appendChild(dash1);

    const endInput = document.createElement('input');
    endInput.type = 'time';
    endInput.dataset.day = day;
    endInput.className = 'day-end';
    endInput.value = d.end || '12:00';
    row.appendChild(endInput);

    const zwsp = document.createElement('span');
    zwsp.style.cssText = 'color:var(--text-muted)';
    zwsp.textContent = '​'; // zero-width space
    row.appendChild(zwsp);

    const breakStartInput = document.createElement('input');
    breakStartInput.type = 'time';
    breakStartInput.dataset.day = day;
    breakStartInput.className = 'day-break-start';
    breakStartInput.value = d.breakStart || '14:00';
    row.appendChild(breakStartInput);

    const dash2 = document.createElement('span');
    dash2.style.cssText = 'color:var(--text-muted)';
    dash2.textContent = '-';
    row.appendChild(dash2);

    const breakEndInput = document.createElement('input');
    breakEndInput.type = 'time';
    breakEndInput.dataset.day = day;
    breakEndInput.className = 'day-break-end';
    breakEndInput.value = d.breakEnd || '18:00';
    row.appendChild(breakEndInput);

    container.appendChild(row);
  }
}

function renderSelectedCategories(selected) {
  const container = document.getElementById('categoriesContainer');
  // Categories are loaded on demand via refreshCategories
  if (!selected || selected.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">暂未选择版块（将监测所有版块）</p>';
  } else {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:12px;">已选择 ${selected.length} 个版块</p>`;
  }
}

async function refreshCategories() {
  const btn = document.getElementById('btnRefreshCategories');
  const status = document.getElementById('categoryStatus');
  btn.disabled = true;
  status.textContent = '获取中...';

  try {
    const result = await chrome.runtime.sendMessage({ action: 'getCategories' });
    if (result.error) {
      status.textContent = result.error;
      return;
    }

    const categories = result.category_list?.categories || [];
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    const selected = settings?.selectedCategories || [];

    const container = document.getElementById('categoriesContainer');
    container.innerHTML = categories
      .filter(c => !c.is_uncategorized)
      .map(c => `
        <div class="category-item">
          <input type="checkbox" data-cat-id="${c.id}" data-cat-slug="${escapeHtml(c.slug)}"
            ${selected.includes(c.id) ? 'checked' : ''}>
          <label>${escapeHtml(c.name)} (${c.topic_count})</label>
        </div>
      `).join('') || '<p style="color:var(--text-muted);font-size:12px;">未获取到版块列表</p>';

    status.textContent = `已加载 ${categories.length} 个版块`;
  } catch (err) {
    status.textContent = '获取失败: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  const btn = document.getElementById('btnSaveSettings');
  const feedback = document.getElementById('saveFeedback');

  const apiKey = document.getElementById('inputApiKey').value.trim();
  if (apiKey && !/^sk-[\w-]{20,}$/.test(apiKey)) {
    feedback.textContent = 'API Key 格式异常，应以 sk- 开头';
    feedback.style.display = 'block';
    feedback.style.color = 'var(--error)';
    setTimeout(() => { feedback.style.display = 'none'; feedback.style.color = 'var(--success)'; }, 3000);
    btn.disabled = false;
    return;
  }

  btn.disabled = true;

  try {
    // Build schedule from UI
    const schedule = {};
    document.querySelectorAll('.schedule-row').forEach(row => {
      const day = row.querySelector('.day-enable').dataset.day;
      schedule[day] = {
        enabled: row.querySelector('.day-enable').checked,
        start: row.querySelector('.day-start').value,
        end: row.querySelector('.day-end').value,
        breakStart: row.querySelector('.day-break-start').value,
        breakEnd: row.querySelector('.day-break-end').value
      };
    });

    // Build selected categories
    const selectedCategories = [];
    document.querySelectorAll('#categoriesContainer input[type="checkbox"]').forEach(cb => {
      if (cb.checked) selectedCategories.push(parseInt(cb.dataset.catId));
    });

    const freq = document.getElementById('selectFrequency').value;
    const freqSettings = FREQ_SETTINGS[freq] || FREQ_SETTINGS.moderate;

    const settings = {
      apiKey: document.getElementById('inputApiKey').value,
      schedule,
      selectedCategories,
      replyFrequency: freq,
      autoReplyComments: document.getElementById('chkAutoComment').checked,
      maxRepliesPerHour: freqSettings.maxRepliesPerHour,
      minReplyInterval: freqSettings.minReplyInterval
    };

    const result = await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
    if (result.error) throw new Error(result.error);

    feedback.textContent = '设置已保存';
    feedback.style.display = 'block';
    setTimeout(() => { feedback.style.display = 'none'; }, 3000);
  } catch (err) {
    feedback.textContent = '保存失败: ' + err.message;
    feedback.style.color = 'var(--error)';
    feedback.style.display = 'block';
    setTimeout(() => {
      feedback.style.display = 'none';
      feedback.style.color = 'var(--success)';
    }, 3000);
  } finally {
    btn.disabled = false;
  }
}
