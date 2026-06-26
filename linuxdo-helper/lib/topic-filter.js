// Topic Filter & Reply Generator
// Uses DeepSeek to evaluate posts and generate valuable replies

/**
 * Prompt: Generate a valuable reply
 */
function buildGenerateReplyPrompt(topic) {
  return {
    system: '你是一个linux.do论坛的用户。请直接输出回复内容，不要任何解释或前缀。',
    user: `请根据以下帖子内容生成一个有价值的回复。

帖子标题：${topic.title}
帖子内容：${topic.excerpt || topic.plain || '(无内容)'}

要求：
1. 回复要有实质信息量，提供帮助、见解或有价值的补充
2. 使用简体中文，语气自然友好，像真实论坛用户
3. 不要无意义灌水、不要纯表情、不要复制粘贴原文
4. 如果帖子是提问，给出具体解答思路或经验
5. 如果帖子是分享，给出建设性反馈或相关经验
6. 如果帖子是讨论，提出有见地的观点
7. 不要包含任何政治敏感、攻击性、广告推广内容
8. 回复长度控制在50-300字之间`
  };
}

/**
 * Prompt: Check reply for safety
 */
function buildSafetyCheckPrompt(replyContent, topic) {
  return {
    system: '你是一个内容审核员。请以JSON格式回复。',
    user: `检查以下回复内容是否存在违规问题：

帖子标题：${topic.title}
回复内容：${replyContent}

检查项：
1. 是否包含政治敏感内容
2. 是否包含人身攻击或不友善言论
3. 是否包含广告或垃圾推广
4. 是否与帖子主题无关
5. 是否无意义灌水、纯表情或复制粘贴

请返回JSON格式（不要其他文字）：
{
  "safe": true/false,
  "issues": ["违规问题列表，safe为true时为空数组"],
  "suggestedAction": "pass/modify/discard"
}`
  };
}

/**
 * Prompt: Generate reply to a comment (someone replied to user's post)
 */
function buildCommentReplyPrompt(topicTitle, originalPostContent, commentContent) {
  return {
    system: '你是一个linux.do论坛的用户。请直接输出回复内容，不要任何解释或前缀。',
    user: `有人在你的帖子下回复了你，请生成一个得体的回复。

帖子标题：${topicTitle}
你的原帖/评内容：${originalPostContent}
对方的回复内容：${commentContent}

要求：
1. 礼貌回应对方的具体观点或问题
2. 使用简体中文，语气友好自然
3. 继续有价值的讨论，不要灌水
4. 如果对方提问则回答，如果对方分享则感谢+反馈
5. 长度控制在30-200字
6. 不要包含任何违规内容`
  };
}

/**
 * Simplified pipeline: generate reply -> safety check (skip worth-replying evaluation)
 * @param {Object} topic - { id, title, excerpt/plain, replyCount }
 * @param {string} apiKey
 * @param {Function} chatFn - chat(apiKey, system, user) function
 * @returns {Promise<{action: string, content?: string, reason?: string}>}
 */
async function generateReplyWithSafetyCheck(topic, apiKey, chatFn) {
  // Step 1: Generate reply
  const genPrompt = buildGenerateReplyPrompt(topic);
  let replyContent;
  try {
    replyContent = await chatFn(apiKey, genPrompt.system, genPrompt.user);
  } catch (e) {
    return { action: 'error', reason: `回复生成失败: ${e.message}` };
  }

  if (!replyContent || replyContent.trim().length < 5) {
    return { action: 'discard', reason: '生成的回复内容为空或过短' };
  }

  // Step 2: Safety check (JSON mode)
  const safetyPrompt = buildSafetyCheckPrompt(replyContent, topic);
  try {
    const safetyText = await chatFn(apiKey, safetyPrompt.system, safetyPrompt.user, {
      extra: { response_format: { type: 'json_object' } }
    });
    const safetyResult = JSON.parse(safetyText);
    if (!safetyResult.safe) {
      return {
        action: 'discard',
        reason: `安全审核未通过: ${(safetyResult.issues || []).join('; ')}`
      };
    }
  } catch (e) {
    return { action: 'discard', reason: `安全审核异常: ${e.message}，已丢弃` };
  }

  return { action: 'reply', content: replyContent.trim() };
}

/**
 * Evaluate and generate a reply to a comment
 */
async function evaluateCommentReply(topicTitle, originalPost, comment, apiKey, chatFn) {
  const prompt = buildCommentReplyPrompt(topicTitle, originalPost, comment);

  let replyContent;
  try {
    replyContent = await chatFn(apiKey, prompt.system, prompt.user);
  } catch (e) {
    return { action: 'error', reason: `评论回复生成失败: ${e.message}` };
  }

  if (!replyContent || replyContent.trim().length < 3) {
    return { action: 'discard', reason: '生成的评论回复为空' };
  }

  // Safety check for comment reply too (use JSON mode)
  const safetyPrompt = buildSafetyCheckPrompt(replyContent, { title: topicTitle });
  try {
    const safetyText = await chatFn(apiKey, safetyPrompt.system, safetyPrompt.user, {
      extra: { response_format: { type: 'json_object' } }
    });
    const safetyResult = JSON.parse(safetyText);
    if (!safetyResult.safe) {
      return { action: 'discard', reason: `评论回复安全审核未通过: ${(safetyResult.issues || []).join('; ')}` };
    }
  } catch (_) {
    return { action: 'discard', reason: '评论回复安全审核异常，已丢弃' };
  }

  return { action: 'reply', content: replyContent.trim() };
}