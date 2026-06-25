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
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('settings').classList.add('hidden');

  if (tab === 'dashboard') {
    document.getElementById('tabDashboard').classList.add('active');
    document.getElementById('dashboard').classList.remove('hidden');
    refreshStatus();
    refreshActivityLog();
  } else {
    document.getElementById('tabSettings').classList.add('active');
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
    renderQueue(status.queue);
  } catch (err) {
    // Silently fail - operation display is not critical
  }
}

function renderCurrentOp(op) {
  const card = document.getElementById('currentOperation');
  if (!card) return;

  if (!op || op.type === 'idle') {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');

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

function renderQueue(queue) {
  const section = document.getElementById('operationQueue');
  const list = document.getElementById('queueList');
  if (!section || !list) return;

  if (!queue || queue.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  const iconMap = {
    completed: '\u2705',
    processing: '\u25B6',
    pending: '\u23F3',
    skipped: '\u23ED',
    discarded: '\u26A0'
  };

  list.innerHTML = queue.map(item => `
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
  const btn = document.getElementById('btnPause');
  const isPaused = btn.textContent === '暂停';
  await chrome.runtime.sendMessage({ action: isPaused ? 'pause' : 'resume' });
  await refreshStatus();
}

async function runNow() {
  const btn = document.getElementById('btnRunNow');
  btn.textContent = '正在运行（可能需要30秒）...';
  btn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'runNow' });
  // Give enough time for the background to complete
  await sleep(5000);
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
  container.innerHTML = DAY_NAMES.map(day => {
    const d = schedule?.[day] || { enabled: false, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' };
    return `
      <div class="schedule-row">
        <label>${DAY_LABELS[day]}</label>
        <input type="checkbox" data-day="${day}" class="day-enable" ${d.enabled ? 'checked' : ''}>
        <input type="time" data-day="${day}" class="day-start" value="${d.start || '09:00'}">
        <span style="color:var(--text-muted)">-</span>
        <input type="time" data-day="${day}" class="day-end" value="${d.end || '12:00'}">
        <span style="color:var(--text-muted)">&#8203;</span>
        <input type="time" data-day="${day}" class="day-break-start" value="${d.breakStart || '14:00'}">
        <span style="color:var(--text-muted)">-</span>
        <input type="time" data-day="${day}" class="day-break-end" value="${d.breakEnd || '18:00'}">
      </div>
    `;
  }).join('');
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
          <input type="checkbox" data-cat-id="${c.id}" data-cat-slug="${c.slug}"
            ${selected.includes(c.id) ? 'checked' : ''}>
          <label>${c.name} (${c.topic_count})</label>
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