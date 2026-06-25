// DeepSeek V4 Flash API client
// OpenAI-compatible API wrapper

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-v4-flash';

/**
 * Raw API call to DeepSeek
 * @param {Array} messages - [{role, content}]
 * @param {Object} options - {temperature, maxTokens, extra}
 * @param {string} apiKey
 * @returns {Promise<Object>} API response
 */
async function callDeepSeek(messages, options = {}, apiKey) {
  if (!apiKey) throw new Error('DeepSeek API Key 未配置');

  const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      ...options.extra
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API 错误 ${response.status}: ${errText}`);
  }

  return response.json();
}

/**
 * Convenience: system + user prompt chat
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {Object} options
 * @returns {Promise<string>} model reply content
 */
async function chat(apiKey, systemPrompt, userPrompt, options = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  const result = await callDeepSeek(messages, options, apiKey);
  return result.choices[0].message.content;
}

/**
 * Convenience: JSON mode chat - forces model to return valid JSON
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {Object} options
 * @returns {Promise<Object>} parsed JSON
 */
async function chatJson(apiKey, systemPrompt, userPrompt, options = {}) {
  const result = await chat(apiKey, systemPrompt, userPrompt, {
    ...options,
    extra: { response_format: { type: 'json_object' } }
  });
  return JSON.parse(result);
}