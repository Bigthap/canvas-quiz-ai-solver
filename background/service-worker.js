// Canvas Quiz AI Solver - Background Service Worker (v1.0.5)
// Handles API calls, atomic batch caching, and cross-frame routing

let tabQuestionStore = {};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['openRouterApiKey', 'model', 'reasoningEffort', 'defaultMode'], (res) => {
    const defaults = {};
    if (!res.model) defaults.model = 'openai/gpt-5.6-luna';
    if (!res.reasoningEffort) defaults.reasoningEffort = 'high';
    if (!res.defaultMode) defaults.defaultMode = 'highlight';
    if (Object.keys(defaults).length > 0) {
      chrome.storage.local.set(defaults);
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;
  const frameId = sender.frameId;

  // 1. Frame reports detected questions
  if (request.action === 'REGISTER_FRAME_QUESTIONS') {
    if (tabId !== null) {
      if (!tabQuestionStore[tabId]) tabQuestionStore[tabId] = {};
      tabQuestionStore[tabId][frameId] = request.payload;

      let total = 0;
      for (const fId in tabQuestionStore[tabId]) {
        total += (tabQuestionStore[tabId][fId] || []).length;
      }
      chrome.tabs.sendMessage(tabId, { action: 'UPDATE_QUESTION_COUNT', count: total }, { frameId: 0 });
    }
    sendResponse({ success: true });
    return true;
  }

  // 2. Cache management: Atomic get, save, clear
  if (request.action === 'GET_CACHE') {
    chrome.storage.local.get(['canvas_ai_cache'], (res) => {
      sendResponse({ success: true, cache: res.canvas_ai_cache || {} });
    });
    return true;
  }

  if (request.action === 'SAVE_BATCH_CACHE') {
    chrome.storage.local.get(['canvas_ai_cache'], (res) => {
      const current = res.canvas_ai_cache || {};
      const updated = { ...current, ...request.payload };
      chrome.storage.local.set({ canvas_ai_cache: updated }, () => {
        console.log(`[Canvas AI] Atomic cache updated: ${Object.keys(updated).length} total entries.`);
        sendResponse({ success: true, count: Object.keys(updated).length });
      });
    });
    return true;
  }

  if (request.action === 'CLEAR_CACHE') {
    chrome.storage.local.remove(['canvas_ai_cache'], () => {
      console.log('[Canvas AI] Cache cleared.');
      sendResponse({ success: true });
    });
    return true;
  }

  // 3. Broadcast apply answers to all frames
  if (request.action === 'BROADCAST_APPLY') {
    if (tabId !== null) {
      chrome.tabs.sendMessage(tabId, {
        action: 'APPLY_ANSWERS_IN_FRAME',
        answers: request.answers,
        mode: request.mode
      });
    }
    sendResponse({ success: true });
    return true;
  }

  // 4. Config check
  if (request.action === 'GET_CONFIG') {
    chrome.storage.local.get(['openRouterApiKey', 'model', 'reasoningEffort', 'defaultMode'], (config) => {
      sendResponse({
        success: true,
        config: {
          hasKey: Boolean(config.openRouterApiKey),
          model: config.model || 'openai/gpt-5.6-luna',
          reasoningEffort: config.reasoningEffort || 'high',
          defaultMode: config.defaultMode || 'highlight'
        }
      });
    });
    return true;
  }

  // 5. Call OpenRouter API to solve
  if (request.action === 'SOLVE_QUIZ') {
    handleSolveQuiz(request.payload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleSolveQuiz(payload) {
  const config = await chrome.storage.local.get(['openRouterApiKey', 'model', 'reasoningEffort']);
  const apiKey = config.openRouterApiKey;
  if (!apiKey) {
    throw new Error('กรุณาระบุ OpenRouter API Key ในหน้าตั้งค่าของ Extension ก่อนใช้งาน');
  }

  const model = config.model || 'openai/gpt-5.6-luna';
  const reasoningEffort = config.reasoningEffort || 'high';

  const systemMessage = {
    role: 'system',
    content: `You are an elite academic examination solver specializing in university general education, BCG economy, sustainability, digital technologies, science, and radiation physics.
Analyze multiple-choice questions (and any accompanying images) thoroughly.
For EACH question:
1. Select the single most scientifically and academically accurate option according to university standards.
2. Provide a clear, concise justification in Thai.
3. CRITICAL: "selected_option_text" MUST be the EXACT verbatim text of your chosen option as written in the Options list.
4. "selected_option_index" MUST be the 0-based integer index corresponding to that option in the provided list.

Return strictly a valid JSON object matching this schema:
{
  "answers": [
    {
      "question_index": 1,
      "selected_option_index": 0,
      "selected_option_text": "Exact text of the chosen option",
      "confidence": "99%",
      "explanation": "Brief explanation in Thai"
    }
  ]
}`
  };

  const userContent = [
    {
      type: 'text',
      text: 'Here are the examination questions to solve. Please identify the correct option for each question:\n\n'
    }
  ];

  payload.questions.forEach((q, qIdx) => {
    const qIndex = q.index !== undefined ? q.index : qIdx + 1;
    let qText = `--- QUESTION #${qIndex} ---\n`;
    qText += `Question: ${q.text}\nOptions:\n`;
    q.options.forEach((opt, oIdx) => {
      qText += `  [${oIdx}] ${opt.text}\n`;
    });
    qText += `\n`;

    userContent.push({ type: 'text', text: qText });

    if (q.images && q.images.length > 0) {
      q.images.forEach((img) => {
        if (img.url && (img.url.startsWith('data:image') || img.url.startsWith('http'))) {
          userContent.push({
            type: 'text',
            text: `[Image attachment for Question #${qIndex}]:`
          });
          userContent.push({
            type: 'image_url',
            image_url: { url: img.url }
          });
        }
      });
    }
  });

  const requestBody = {
    model: model,
    messages: [systemMessage, { role: 'user', content: userContent }],
    temperature: 0.1
  };

  if (reasoningEffort && reasoningEffort !== 'none') {
    requestBody.reasoning = { effort: reasoningEffort };
  }

  console.log(`[Canvas AI] Batch solving ${payload.questions.length} questions using ${model}...`);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mango-cmu.instructure.com',
      'X-Title': 'Canvas Quiz Assistant'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errDetail = errorBody;
    try {
      const errJson = JSON.parse(errorBody);
      errDetail = errJson.error?.message || errorBody;
    } catch (_) {}
    throw new Error(`OpenRouter API Error (${response.status}): ${errDetail}`);
  }

  const result = await response.json();
  const rawReply = result.choices?.[0]?.message?.content;
  if (!rawReply) {
    throw new Error('ไม่ได้รับข้อมูลคำตอบจากโมเดล AI');
  }

  let cleanJson = rawReply.trim();
  if (cleanJson.includes('```json')) {
    cleanJson = cleanJson.split('```json')[1].split('```')[0].trim();
  } else if (cleanJson.includes('```')) {
    cleanJson = cleanJson.split('```')[1].split('```')[0].trim();
  }

  try {
    const parsed = JSON.parse(cleanJson);
    return {
      answers: parsed.answers || [],
      modelUsed: result.model || model,
      usage: result.usage
    };
  } catch (parseErr) {
    throw new Error('AI ตอบกลับมาไม่ใช่รูปแบบ JSON ที่ถูกต้อง: ' + cleanJson.substring(0, 200));
  }
}
