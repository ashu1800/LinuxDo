// Scheduler - Time schedule management and rate limiter

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Check if current time falls within configured working hours
 * Supports two periods per day with a break in between
 */
function isWithinWorkingHours(schedule) {
  const today = DAY_NAMES[new Date().getDay()];
  const daySchedule = schedule[today];
  if (!daySchedule || !daySchedule.enabled) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  // Period 1: start -> end (e.g. 09:00-12:00)
  const p1Start = timeToMinutes(daySchedule.start);
  const p1End = timeToMinutes(daySchedule.end);
  const inPeriod1 = currentMinutes >= p1Start && currentMinutes < p1End;

  // Period 2: breakStart -> breakEnd (e.g. 14:00-18:00)
  let inPeriod2 = false;
  if (daySchedule.breakStart && daySchedule.breakEnd) {
    const p2Start = timeToMinutes(daySchedule.breakStart);
    const p2End = timeToMinutes(daySchedule.breakEnd);
    inPeriod2 = currentMinutes >= p2Start && currentMinutes < p2End;
  }

  return inPeriod1 || inPeriod2;
}

/**
 * Get human-readable status of current schedule
 */
function getScheduleStatus(schedule) {
  const today = DAY_NAMES[new Date().getDay()];
  const daySchedule = schedule[today];

  if (!daySchedule || !daySchedule.enabled) {
    return { working: false, label: '今日休息', nextCheck: null };
  }

  if (isWithinWorkingHours(schedule)) {
    return { working: true, label: '工作中', nextCheck: null };
  }

  // Calculate next working period
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const p1Start = timeToMinutes(daySchedule.start);
  const p1End = timeToMinutes(daySchedule.end);
  const p2Start = daySchedule.breakStart ? timeToMinutes(daySchedule.breakStart) : null;

  let nextStart = null;
  if (currentMinutes < p1Start) {
    nextStart = daySchedule.start;
  } else if (currentMinutes >= p1End && p2Start && currentMinutes < p2Start) {
    nextStart = daySchedule.breakStart;
  }

  return {
    working: false,
    label: '休息中',
    nextCheck: nextStart
  };
}

function timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/**
 * Check if we can reply based on rate limiting
 * Mutates state object directly
 */
function canReplyNow(state, settings) {
  if (state.isPaused) return { allowed: false, reason: '已暂停' };

  const now = Date.now();
  const hourAgo = now - 3600000;

  // Reset hourly counter if a new hour has started
  if (state.replyHourStart < hourAgo) {
    state.replyCountThisHour = 0;
    state.replyHourStart = now;
  }

  if (state.replyCountThisHour >= settings.maxRepliesPerHour) {
    const nextReset = new Date(state.replyHourStart + 3600000);
    return {
      allowed: false,
      reason: `已达每小时上限 (${settings.maxRepliesPerHour}条)，${nextReset.toLocaleTimeString('zh-CN')} 后重置`
    };
  }

  const elapsed = now - state.lastReplyTime;
  const minInterval = settings.minReplyInterval * 60000;
  if (elapsed < minInterval) {
    const waitSeconds = Math.ceil((minInterval - elapsed) / 1000);
    return { allowed: false, reason: `间隔未到，还需等待 ${waitSeconds} 秒` };
  }

  return { allowed: true, reason: '' };
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}