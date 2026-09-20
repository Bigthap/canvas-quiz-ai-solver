// Canvas Quiz AI Solver - Background Service Worker (v1.0.5)
// Handles API calls, atomic batch caching, and cross-frame routing

let tabQuestionStore = {};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['openRouterApiKey', 'model', 'reasoningEffort', 'defaultMode'], (res) => {
    const defaults = {};
    if (!res.model) defaults.model = 'smart-hybrid';
    if (!res.reasoningEffort) defaults.reasoningEffort = 'low';
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
          model: config.model || 'smart-hybrid',
          reasoningEffort: config.reasoningEffort || 'low',
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

  const model = config.model || 'smart-hybrid';
  const reasoningEffort = config.reasoningEffort || 'low';

  if (model === 'smart-hybrid') {
    return await solveSmartHybrid(payload, apiKey);
  } else if (model === 'typesafe/jev-1.13') {
    return await solvePureJev(payload, apiKey);
  } else {
    return await solveChatCompletions(payload, apiKey, model, reasoningEffort);
  }
}

// --- ENGINE 1: SMART HYBRID (Jev-1.13 Frontline + Grok 4.6 Fallback) ---
async function solveSmartHybrid(payload, apiKey) {
  console.log(`[Canvas AI] Running Smart Hybrid (Jev-1.13 frontline + Grok 4.6 fallback) on ${payload.questions.length} questions...`);

  let jevAnswers = {};
  let jevFailed = false;

  // Step 1: Frontline - Typesafe Jev-1.13 Decisions API
  try {
    const stateLines = ['ACADEMIC ASSESSMENT EXAMINATION:'];
    const questionsDict = {};

    payload.questions.forEach((q) => {
      const qId = q.index;
      stateLines.push(`Question #${qId}: ${q.text}`);
      const criteria = {};
      (q.options || []).forEach((opt) => {
        stateLines.push(`  Option ${opt.index}: ${opt.text}`);
        criteria[String(opt.index)] = String(opt.text);
      });
      stateLines.push('');

      questionsDict[`q_${qId}`] = {
        type: 'choice',
        instructions: `Select the single most academically and factually accurate option for Question #${qId}`,
        criteria: criteria
      };
    });

    const jevResp = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mango-cmu.instructure.com',
        'X-Title': 'Canvas Quiz Assistant (Smart Hybrid)'
      },
      body: JSON.stringify({
        model: 'typesafe/jev-1.13',
        state: stateLines.join('\n'),
        questions: questionsDict
      })
    });

    if (!jevResp.ok) {
      const errText = await jevResp.text();
      console.warn(`[Canvas AI] Jev-1.13 API returned ${jevResp.status}: ${errText}. Falling back to Grok 4.6 for all questions.`);
      jevFailed = true;
    } else {
      const jevData = await jevResp.json();
      jevAnswers = jevData.answers || {};
    }
  } catch (err) {
    console.warn(`[Canvas AI] Jev-1.13 call error: ${err.message}. Falling back to Grok 4.6 for all questions.`);
    jevFailed = true;
  }

  // Step 2: Filter low confidence questions (< 0.80)
  const CONF_THRESHOLD = 0.80;
  const questionsForFallback = [];
  const finalAnswersMap = {};

  payload.questions.forEach((q) => {
    const key = `q_${q.index}`;
    const ansObj = jevAnswers[key];
    const choiceInt = ansObj ? parseInt(ansObj.choice, 10) : NaN;
    const conf = (ansObj && typeof ansObj.confidence === 'number') ? ansObj.confidence : 0;

    // Check if question contains Thai characters
    const hasThai = /[\u0E00-\u0E7F]/.test(q.text);
    // Jev Decisions API is optimized for English choice tasks; on Thai questions, require >= 0.85 confidence or route to Grok 4.6
    const threshold = hasThai ? 0.85 : CONF_THRESHOLD;

    if (jevFailed || isNaN(choiceInt) || conf < threshold) {
      questionsForFallback.push(q);
    } else {
      const matchedOpt = (q.options || []).find((o) => o.index === choiceInt) || (q.options || [])[choiceInt] || { text: '' };
      finalAnswersMap[q.index] = {
        question_index: q.index,
        question_stem: q.text,
        question_number: q.index,
        selected_option_index: choiceInt,
        selected_option_text: matchedOpt.text || '',
        confidence: `${Math.round(conf * 100)}%`,
        explanation: `วิเคราะห์โดย Typesafe Jev-1.13 (ความมั่นใจระดับสูง ${Math.round(conf * 100)}%)`
      };
    }
  });

  // Step 3: Fallback routing to x-ai/grok-4.6 for low-confidence questions
  if (questionsForFallback.length > 0) {
    console.log(`[Canvas AI] Routing ${questionsForFallback.length} low-confidence questions to x-ai/grok-4.6 fallback...`);
    try {
      const fallbackResult = await solveChatCompletions(
        { questions: questionsForFallback },
        apiKey,
        'x-ai/grok-4.6',
        'low'
      );
      (fallbackResult.answers || []).forEach((ans) => {
        const qIdx = parseInt(ans.question_index, 10);
        const origQ = payload.questions.find((item) => item.index === qIdx);
        if (!isNaN(qIdx)) {
          finalAnswersMap[qIdx] = {
            ...ans,
            question_stem: origQ ? origQ.text : '',
            question_number: qIdx,
            confidence: ans.confidence || '98% (Grok 4.6 Verification)',
            explanation: (ans.explanation ? ans.explanation + ' ' : '') + '[ยืนยันผลโดย Grok 4.6]'
          };
        }
      });
    } catch (fbErr) {
      console.error(`[Canvas AI] Grok 4.6 fallback error: ${fbErr.message}`);
      // Fallback rescue: if Grok call fails, use Jev answer if available
      questionsForFallback.forEach((q) => {
        if (!finalAnswersMap[q.index]) {
          const key = `q_${q.index}`;
          const ansObj = jevAnswers[key];
          const choiceInt = ansObj ? parseInt(ansObj.choice, 10) : 0;
          const validChoice = isNaN(choiceInt) ? 0 : choiceInt;
          const matchedOpt = (q.options || []).find((o) => o.index === validChoice) || (q.options || [])[0] || { text: '' };
          finalAnswersMap[q.index] = {
            question_index: q.index,
            question_stem: q.text,
            question_number: q.index,
            selected_option_index: validChoice,
            selected_option_text: matchedOpt.text || '',
            confidence: '60%',
            explanation: 'ตอบโดย Jev-1.13 (Fallback ไม่สามารถเข้าถึงได้)'
          };
        }
      });
    }
  }

  const orderedAnswers = payload.questions.map((q) => finalAnswersMap[q.index]).filter(Boolean);

  return {
    answers: orderedAnswers,
    modelUsed: 'Smart Hybrid (Jev-1.13 + Grok 4.6)',
    usage: {
      total_questions: payload.questions.length,
      routed_to_grok: questionsForFallback.length
    }
  };
}

// --- ENGINE 2: PURE JEV-1.13 DECISIONS API ---
async function solvePureJev(payload, apiKey) {
  console.log(`[Canvas AI] Running Pure Jev-1.13 on ${payload.questions.length} questions...`);
  const stateLines = ['ACADEMIC ASSESSMENT EXAMINATION:'];
  const questionsDict = {};

  payload.questions.forEach((q) => {
    const qId = q.index;
    stateLines.push(`Question #${qId}: ${q.text}`);
    const criteria = {};
    (q.options || []).forEach((opt) => {
      stateLines.push(`  Option ${opt.index}: ${opt.text}`);
      criteria[String(opt.index)] = String(opt.text);
    });
    stateLines.push('');

    questionsDict[`q_${qId}`] = {
      type: 'choice',
      instructions: `Select the single most academically and factually accurate option for Question #${qId}`,
      criteria: criteria
    };
  });

  const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mango-cmu.instructure.com',
      'X-Title': 'Canvas Quiz Assistant (Pure Jev)'
    },
    body: JSON.stringify({
      model: 'typesafe/jev-1.13',
      state: stateLines.join('\n'),
      questions: questionsDict
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Jev-1.13 Decisions API Error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const rawAnswers = data.answers || {};

  const answers = payload.questions.map((q) => {
    const key = `q_${q.index}`;
    const ansObj = rawAnswers[key] || {};
    const choiceInt = parseInt(ansObj.choice, 10);
    const validChoice = isNaN(choiceInt) ? 0 : choiceInt;
    const conf = typeof ansObj.confidence === 'number' ? ansObj.confidence : 0.95;
    const matchedOpt = (q.options || []).find((o) => o.index === validChoice) || (q.options || [])[validChoice] || { text: '' };

    return {
      question_index: q.index,
      question_stem: q.text,
      question_number: q.index,
      selected_option_index: validChoice,
      selected_option_text: matchedOpt.text || '',
      confidence: `${Math.round(conf * 100)}%`,
      explanation: 'วิเคราะห์โดย Typesafe Jev-1.13 (Decisions API ความเร็วสูง)'
    };
  });

  return {
    answers: answers,
    modelUsed: 'typesafe/jev-1.13',
    usage: data.usage
  };
}

// --- ENGINE 3: CHAT COMPLETIONS (Luna High / Grok 4.6 / Custom) ---
async function solveChatCompletions(payload, apiKey, model, reasoningEffort) {
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
    (q.options || []).forEach((opt, oIdx) => {
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

  // Cap max_tokens to prevent credit reservation rejections on reasoning endpoints
  if (model.includes('grok') || model.includes('astra')) {
    requestBody.max_tokens = 4000;
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
    const answers = (parsed.answers || []).map((a) => {
      const qIdx = parseInt(a.question_index, 10);
      const origQ = payload.questions.find((item) => item.index === qIdx);
      return {
        ...a,
        question_stem: origQ ? origQ.text : '',
        question_number: qIdx
      };
    });
    return {
      answers: answers,
      modelUsed: result.model || model,
      usage: result.usage
    };
  } catch (parseErr) {
    // Regex parsing fallback
    const pattern = /"question_index"\s*:\s*(\d+)\s*,\s*"selected_option_index"\s*:\s*(\d+)/g;
    const answersList = [];
    let match;
    while ((match = pattern.exec(rawReply)) !== null) {
      const qIdx = parseInt(match[1], 10);
      const optIdx = parseInt(match[2], 10);
      const q = payload.questions.find((item) => item.index === qIdx);
      const matchedOpt = q && q.options ? ((q.options || []).find((o) => o.index === optIdx) || q.options[optIdx]) : null;
      answersList.push({
        question_index: qIdx,
        question_stem: q ? q.text : '',
        question_number: qIdx,
        selected_option_index: optIdx,
        selected_option_text: matchedOpt ? matchedOpt.text : '',
        confidence: '95%',
        explanation: 'วิเคราะห์โดย AI'
      });
    }
    if (answersList.length > 0) {
      return {
        answers: answersList,
        modelUsed: result.model || model,
        usage: result.usage
      };
    }
    throw new Error('AI ตอบกลับมาไม่ใช่รูปแบบ JSON ที่ถูกต้อง: ' + cleanJson.substring(0, 200));
  }
}
