// Canvas Quiz AI Solver - Content Script (v1.0.9 Dual-Engine: Single Page & Multi-Page)
// Supports:
// 1. All-in-One Single Page Quizzes (all questions scrollable in 1 page)
// 2. One-at-a-Time Paginated Quizzes (questions paginated 1 by 1)
// 3. Robust Text-First Option Matching (Prevents index shifts and random clicks)
// 4. Document-Order DOM Question Scraper (Reliable sequential ordering)
// 5. Triple-Tier Persistent Cache (Instant Cache Hits)

(function () {
  'use strict';

  if (window.__CANVAS_AI_INJECTED_V109__) return;
  window.__CANVAS_AI_INJECTED_V109__ = true;

  const isTopWindow = window === window.top;

  // State Management
  let allPageQuestions = []; // Stored array of all questions on the page
  let currentQuestion = null;
  let answerCache = new Map(); // Key: normalized text or q_num_X -> Answer object
  let currentMode = 'highlight'; // 'highlight' (default) or 'autoclick'
  let autoPilotEnabled = true;
  let isHarvesting = false;
  let isAutoClickingAll = false;
  let shadowRoot = null;
  let activeHighlights = [];

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    await loadPersistentCache();

    if (isTopWindow) {
      createFloatingUI();
    }

    // Auto-detect and scan questions on page
    await refreshQuestionsOnPage();

    // Re-apply highlights whenever cache loads or page mutates
    observePageMutations();
  }

  // --- PERSISTENT CACHE ---
  async function loadPersistentCache() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_CACHE' }, (res) => {
        if (res && res.cache) {
          for (const key in res.cache) {
            answerCache.set(key, res.cache[key]);
          }
          console.log(`[Canvas AI] Loaded ${answerCache.size} cache entries into memory.`);
        }
        resolve();
      });
    });
  }

  function saveBatchToCache(batchMap) {
    for (const key in batchMap) {
      answerCache.set(key, batchMap[key]);
    }
    chrome.runtime.sendMessage({ action: 'SAVE_BATCH_CACHE', payload: batchMap });
  }

  function getCachedAnswer(q) {
    if (!q || !q.text) return null;

    // Tier 1: Exact normalized text match
    const textKey = normalizeKey(q.text);
    if (textKey && answerCache.has(textKey)) {
      return answerCache.get(textKey);
    }

    // Tier 2: Substring fuzzy match
    if (textKey && textKey.length > 10) {
      for (const [k, ans] of answerCache.entries()) {
        if (!k.startsWith('q_num_')) {
          if (k.includes(textKey) || textKey.includes(k)) {
            return ans;
          }
          if (calculateSimilarity(k, textKey) >= 0.75) {
            return ans;
          }
        }
      }
    }

    // Tier 3: Question number fallback ONLY IF STEM MATCHES!
    if (q.number) {
      const numKey = `q_num_${q.number}`;
      if (answerCache.has(numKey)) {
        const cachedAns = answerCache.get(numKey);
        if (cachedAns && (cachedAns.question_stem || cachedAns.stem)) {
          const stemToCompare = cachedAns.question_stem || cachedAns.stem;
          const sim = calculateSimilarity(cleanStem(stemToCompare), cleanStem(q.text));
          if (sim >= 0.45) {
            return cachedAns;
          }
          console.warn(`[Canvas AI] Cache Tier 3 rejected: q_num_${q.number} stem mismatch (similarity ${sim.toFixed(2)})`);
        }
      }
    }

    return null;
  }

  function normalizeKey(str) {
    if (!str) return '';
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[^\w\s\u0E00-\u0E7F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function cleanText(txt) {
    if (!txt) return '';
    return txt
      .replace(/,\s*Not Selected/gi, '')
      .replace(/,\s*Selected/gi, '')
      .replace(/Not Selected/gi, '')
      .replace(/Selected/gi, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanStem(txt) {
    if (!txt) return '';
    return txt
      .replace(/Multiple choice/gi, '')
      .replace(/\d+(\.\d+)?\s*points?/gi, '')
      .replace(/\d+\s*\/\s*\d+\s*points?/gi, '')
      .replace(/คะแนน/gi, '')
      .replace(/^\s*\d+\s*[\.\)]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.replace(/\s+/g, '').toLowerCase();
    const s2 = str2.replace(/\s+/g, '').toLowerCase();
    if (s1 === s2) return 1;
    if (s1.includes(s2) || s2.includes(s1)) {
      return Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
    }
    const getBigrams = (str) => {
      const bigrams = new Set();
      for (let i = 0; i < str.length - 1; i++) {
        bigrams.add(str.slice(i, i + 2));
      }
      return bigrams;
    };
    const b1 = getBigrams(s1);
    const b2 = getBigrams(s2);
    if (b1.size === 0 || b2.size === 0) return 0;
    let intersection = 0;
    for (const bg of b1) {
      if (b2.has(bg)) intersection++;
    }
    return (2.0 * intersection) / (b1.size + b2.size);
  }

  function findMatchingOption(q, ans) {
    if (!ans || !q || !q.options || q.options.length === 0) return null;

    // 1. Exact text match
    if (ans.selected_option_text) {
      const targetClean = cleanText(ans.selected_option_text).toLowerCase();
      const exact = q.options.find(
        (opt) => cleanText(opt.text).toLowerCase() === targetClean
      );
      if (exact) return exact;

      // 2. Substring containment match
      const sub = q.options.find((opt) => {
        const optClean = cleanText(opt.text).toLowerCase();
        return optClean.length > 3 && targetClean.length > 3 &&
          (optClean.includes(targetClean) || targetClean.includes(optClean));
      });
      if (sub) return sub;

      // 3. High similarity match (score >= 0.5)
      let bestOpt = null;
      let bestScore = 0;
      for (const opt of q.options) {
        const optClean = cleanText(opt.text).toLowerCase();
        const score = calculateSimilarity(targetClean, optClean);
        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestOpt = opt;
        }
      }
      if (bestOpt) return bestOpt;
    }

    // 4. Fallback to index ONLY if question stem is verified to match!
    const stemToCompare = ans.question_stem || ans.stem;
    const isSameQuestion = stemToCompare
      ? calculateSimilarity(cleanStem(stemToCompare), cleanStem(q.text)) >= 0.45
      : false;

    if (
      isSameQuestion &&
      typeof ans.selected_option_index === 'number' &&
      ans.selected_option_index >= 0 &&
      ans.selected_option_index < q.options.length
    ) {
      return q.options[ans.selected_option_index];
    }

    return null;
  }

  async function imageToBase64(img) {
    if (!img || !img.src) return null;
    if (img.src.startsWith('data:image')) return img.src;

    return new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 300;
        canvas.height = img.naturalHeight || img.height || 200;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        fetch(img.src, { credentials: 'include' })
          .then((res) => res.blob())
          .then((blob) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          })
          .catch(() => resolve(null));
      }
    });
  }

  // --- MODE DETECTION ---
  function detectQuizMode() {
    const radioInputs = Array.from(document.querySelectorAll('input[type="radio"]')).filter(
      (r) => r.offsetParent !== null
    );
    const groups = new Set(radioInputs.map((r) => r.name || 'default'));
    return groups.size > 1 ? 'ALL_IN_ONE' : 'ONE_AT_A_TIME';
  }

  // --- ROBUST QUESTION NUMBER EXTRACTION (LEARNOSITY / CANVAS NEW QUIZZES COMPLIANT) ---
  function extractQuestionNumber(container, defaultNum = 1) {
    // 1. Learnosity / Canvas New Quizzes explicit selectors
    const lrnSelectors = [
      '.lrn_question_number',
      '.item-count',
      '.item-index',
      '[data-item-order]',
      '[data-question-order]',
      '[data-question-number]',
      '.question-number',
      '.badge-number'
    ];
    for (const sel of lrnSelectors) {
      const el = (container && container.querySelector(sel)) || document.querySelector(sel);
      if (el) {
        const txt = (el.innerText || el.getAttribute('data-item-order') || el.getAttribute('data-question-order') || '').trim();
        const n = parseInt(txt, 10);
        if (!isNaN(n) && n >= 1 && n <= 200) return n;
      }
    }

    // 2. Search for the badge element preceding "Multiple choice ... points" or "คะแนน"
    const pointsTargets = (container || document).querySelectorAll('span, div, p');
    for (const el of pointsTargets) {
      const txt = (el.innerText || '').trim();
      if (/^(Multiple choice|หลายตัวเลือก)/i.test(txt) || /points?|คะแนน/i.test(txt)) {
        // Look at previous siblings
        let prev = el.previousElementSibling;
        while (prev) {
          const prevTxt = (prev.innerText || '').trim();
          if (/^\d+$/.test(prevTxt)) {
            const n = parseInt(prevTxt, 10);
            if (n >= 1 && n <= 200) return n;
          }
          prev = prev.previousElementSibling;
        }
        // Look at parent children
        if (el.parentElement) {
          for (const child of el.parentElement.children) {
            const cTxt = (child.innerText || '').trim();
            if (/^\d+$/.test(cTxt)) {
              const n = parseInt(cTxt, 10);
              if (n >= 1 && n <= 200) return n;
            }
          }
        }
      }
    }

    // 3. Search container for badge-like numbers
    if (container) {
      const badgeCandidates = container.querySelectorAll('[class*="question-number"], [class*="badge"], [class*="number"], [aria-label*="Question"], [aria-label*="ข้อ"], span, div');
      for (const badge of badgeCandidates) {
        const txt = (badge.innerText || '').trim();
        if (badge.children.length === 0 && /^\d+$/.test(txt)) {
          const val = parseInt(txt, 10);
          if (val >= 1 && val <= 200) return val;
        }
        const m = txt.match(/^(?:question|ข้อที่|ข้อ)?\s*(\d+)[:\.]?$/i);
        if (m) {
          const val = parseInt(m[1], 10);
          if (val >= 1 && val <= 200) return val;
        }
      }
    }

    // 4. In ONE_AT_A_TIME mode, search globally for standalone badges
    const mode = detectQuizMode();
    if (mode === 'ONE_AT_A_TIME') {
      const allCandidates = Array.from(document.querySelectorAll('button, span, div'));
      for (const el of allCandidates) {
        if (el.children.length === 0) {
          const txt = (el.innerText || '').trim();
          if (/^\d+$/.test(txt) && txt.length <= 3) {
            const val = parseInt(txt, 10);
            const rect = el.getBoundingClientRect();
            if (rect.top > 0 && rect.top < window.innerHeight * 0.5 && val >= 1 && val <= 200) {
              return val;
            }
          }
        }
      }
    }

    return defaultNum;
  }

  // --- UNIVERSAL MULTI-QUESTION SCRAPER ---
  async function scrapeAllQuestionsOnPage() {
    const radioInputs = Array.from(document.querySelectorAll('input[type="radio"]')).filter(
      (r) => r.offsetParent !== null
    );
    if (radioInputs.length < 2) return [];

    // Group radio inputs strictly by question container in document order
    const containerMap = new Map();

    radioInputs.forEach((r) => {
      const container =
        r.closest('.lrn-item-wrapper') ||
        r.closest('.lrn_item') ||
        r.closest('.lrn_question') ||
        r.closest('[data-automation="question-item"]') ||
        r.closest('.display_question') ||
        r.closest('.question_holder') ||
        r.closest('fieldset') ||
        r.closest('[role="radiogroup"]') ||
        r.closest('form') ||
        r.parentElement.parentElement;

      if (!containerMap.has(container)) {
        containerMap.set(container, []);
      }
      containerMap.get(container).push(r);
    });

    // Sort containers strictly by document position (top to bottom)
    const sortedContainers = Array.from(containerMap.keys()).sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const questions = [];
    let sequentialIndex = 1;

    for (const container of sortedContainers) {
      const radios = containerMap.get(container);
      if (!radios || radios.length < 2) continue;

      // Ensure radios within container are also strictly in DOM order
      radios.sort((a, b) => {
        if (a === b) return 0;
        const pos = a.compareDocumentPosition(b);
        return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
      });

      // Extract Question Stem
      let stemText = '';
      const legend = container.querySelector('legend');
      if (legend) {
        stemText = legend.innerText;
      } else {
        const promptEl = container.querySelector('[class*="stimulus"], [class*="prompt"], [class*="text"], h2, h3, h4');
        if (promptEl) {
          stemText = promptEl.innerText;
        } else {
          const clone = container.cloneNode(true);
          clone.querySelectorAll('label, input, button, [role="radio"]').forEach((el) => el.remove());
          stemText = clone.innerText;
        }
      }

      stemText = cleanStem(stemText);
      if (!stemText || stemText.length < 5 || stemText.toLowerCase().includes('question at position')) {
        const prevHeading = container.parentElement ? container.parentElement.querySelector('h1, h2, h3, [class*="stimulus"], [class*="prompt"]') : null;
        if (prevHeading) stemText = cleanStem(prevHeading.innerText);
      }

      // Extract Options
      const options = [];
      radios.forEach((r, idx) => {
        const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`) || r.parentElement;
        const rawText = label ? label.innerText : '';
        options.push({
          index: idx,
          text: cleanText(rawText),
          targetElement: label || r
        });
      });

      // Extract Images
      const images = [];
      const imgEls = container.querySelectorAll('img');
      for (const img of imgEls) {
        if (img.width > 25 && img.height > 25) {
          const b64 = await imageToBase64(img);
          if (b64) images.push({ url: b64 });
        }
      }

      // Determine Question Number reliably
      const qNum = extractQuestionNumber(container, sequentialIndex);

      questions.push({
        number: qNum,
        text: stemText,
        options: options,
        images: images,
        container: container
      });

      sequentialIndex++;
    }

    return questions;
  }

  // --- HIGHLIGHT ENGINE (SUPPORTS SINGLE AND ALL QUESTIONS) ---
  function applyAllHighlightsOnPage() {
    if (isHarvesting) return;
    clearHighlights();

    allPageQuestions.forEach((q) => {
      const ans = getCachedAnswer(q);
      if (ans) {
        const targetOpt = findMatchingOption(q, ans);
        if (targetOpt && targetOpt.targetElement) {
          const el = targetOpt.targetElement;
          el.style.setProperty('box-shadow', '0 0 20px rgba(16, 185, 129, 0.95)', 'important');
          el.style.setProperty('border', '2px solid #10b981', 'important');
          el.style.setProperty('background-color', 'rgba(16, 185, 129, 0.18)', 'important');
          el.style.setProperty('border-radius', '8px', 'important');
          el.style.setProperty('transition', 'all 0.25s ease', 'important');
          activeHighlights.push(el);
        }
      }
    });
  }

  function clearHighlights() {
    activeHighlights.forEach((el) => {
      el.style.removeProperty('box-shadow');
      el.style.removeProperty('border');
      el.style.removeProperty('background-color');
      el.style.removeProperty('border-radius');
    });
    activeHighlights = [];
  }

  async function performClick(targetElement) {
    if (!targetElement) return;

    const opts = { bubbles: true, cancelable: true, view: window };
    targetElement.dispatchEvent(new PointerEvent('pointerdown', opts));
    targetElement.dispatchEvent(new MouseEvent('mousedown', opts));
    targetElement.dispatchEvent(new PointerEvent('pointerup', opts));
    targetElement.dispatchEvent(new MouseEvent('mouseup', opts));
    targetElement.click();

    const input = targetElement.tagName === 'INPUT' ? targetElement : targetElement.querySelector('input[type="radio"]');
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // --- QUESTION SCAN & DOM OBSERVER ---
  async function refreshQuestionsOnPage() {
    allPageQuestions = await scrapeAllQuestionsOnPage();
    const mode = detectQuizMode();

    if (allPageQuestions.length > 0) {
      currentQuestion = allPageQuestions[0];
      updateBadgeInfo(allPageQuestions.length, mode);

      // In All-in-One mode, automatically light up all cached answers across the page!
      if (mode === 'ALL_IN_ONE') {
        applyAllHighlightsOnPage();
      } else {
        // One at a time mode
        const ans = getCachedAnswer(currentQuestion);
        if (ans) {
          applySingleHighlight(currentQuestion, ans);
          renderSingleResult(ans, currentQuestion, true);
        }
      }
    }
  }

  function applySingleHighlight(q, ans) {
    clearHighlights();
    if (!q || !ans) return;
    const ansObj = typeof ans === 'object' ? ans : null;
    if (!ansObj) return;
    const targetOpt = findMatchingOption(q, ansObj);
    if (targetOpt && targetOpt.targetElement) {
      const target = targetOpt.targetElement;
      target.style.setProperty('box-shadow', '0 0 20px rgba(16, 185, 129, 0.95)', 'important');
      target.style.setProperty('border', '2px solid #10b981', 'important');
      target.style.setProperty('background-color', 'rgba(16, 185, 129, 0.18)', 'important');
      target.style.setProperty('border-radius', '8px', 'important');
      target.style.setProperty('transition', 'all 0.25s ease', 'important');
      activeHighlights.push(target);
    }
  }

  let debounceTimer = null;
  function observePageMutations() {
    const observer = new MutationObserver(() => {
      if (isHarvesting || isAutoClickingAll) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        await refreshQuestionsOnPage();
      }, 350);
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // Periodic heartbeat to maintain highlights
    setInterval(() => {
      if (!isHarvesting && !isAutoClickingAll && allPageQuestions.length > 0) {
        if (activeHighlights.length === 0 || !document.body.contains(activeHighlights[0])) {
          const mode = detectQuizMode();
          if (mode === 'ALL_IN_ONE') {
            applyAllHighlightsOnPage();
          } else if (currentQuestion) {
            const ans = getCachedAnswer(currentQuestion);
            if (ans) applySingleHighlight(currentQuestion, ans);
          }
        }
      }
    }, 1500);
  }

  // --- SINGLE QUESTION SOLVER (INSTANT 1-QUESTION SOLVE) ---
  async function solveCurrentQuestionOnly() {
    await refreshQuestionsOnPage();
    if (!currentQuestion || !currentQuestion.text) {
      updateStatus('⚠️ ไม่พบโจทย์ข้อสอบบนหน้านี้ กรุณาตรวจสอบหน้าจอ Canvas', true);
      return;
    }

    const q = currentQuestion;
    updateStatus(`🔍 กำลังตรวจสอบข้อที่ ${q.number}...`);

    // Check cache first
    const cached = getCachedAnswer(q);
    if (cached) {
      updateStatus(`⚡ ข้อที่ ${q.number} มีคำตอบใน Cache แล้ว!`);
      applySingleHighlight(q, cached);
      renderSingleResult(cached, q, true);
      if (currentMode === 'autoclick') {
        const opt = findMatchingOption(q, cached);
        if (opt && opt.targetElement) await performClick(opt.targetElement);
      }
      return;
    }

    // Not in cache -> Send to AI
    updateStatus(`🚀 กำลังส่งข้อที่ ${q.number} ให้ AI วิเคราะห์สด...`);
    const solveBtn = shadowRoot?.getElementById('solve-current-btn');
    if (solveBtn) {
      solveBtn.disabled = true;
      solveBtn.innerText = '⏳ กำลังวิเคราะห์...';
    }

    const payload = {
      questions: [
        {
          index: q.number,
          text: q.text,
          options: q.options.map((o) => ({ index: o.index, text: o.text })),
          images: q.images
        }
      ]
    };

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SOLVE_QUIZ', payload }, resolve);
      });

      if (!response || !response.success) {
        updateStatus(response?.error || 'เกิดข้อผิดพลาดในการวิเคราะห์ข้อนี้', true);
        return;
      }

      const answers = response.data?.answers || [];
      const ans = answers[0];
      if (ans) {
        ans.question_stem = q.text;
        ans.question_number = q.number;

        const textKey = normalizeKey(q.text);
        const numKey = `q_num_${q.number}`;
        const batchMap = {};
        batchMap[textKey] = ans;
        batchMap[numKey] = ans;
        saveBatchToCache(batchMap);

        applySingleHighlight(q, ans);
        renderSingleResult(ans, q, false);

        if (currentMode === 'autoclick') {
          const opt = findMatchingOption(q, ans);
          if (opt && opt.targetElement) await performClick(opt.targetElement);
        }

        updateStatus(`🎉 วิเคราะห์ข้อที่ ${q.number} สำเร็จ (${ans.confidence || '99%'})!`);
      } else {
        updateStatus('AI ไม่ได้ส่งคำตอบกลับมาสำหรับข้อนี้', true);
      }
    } catch (err) {
      updateStatus(`ข้อผิดพลาด: ${err.message}`, true);
    } finally {
      if (solveBtn) {
        solveBtn.disabled = false;
        solveBtn.innerText = '⚡ วิเคราะห์ข้อนี้ทันที';
      }
    }
  }

  // --- SMART BATCH SOLVER (HANDLES BOTH SINGLE-PAGE & MULTI-PAGE) ---
  async function runBatchSweepAndSolve() {
    if (isHarvesting) {
      isHarvesting = false;
      updateStatus('🛑 ยกเลิกการกวาดข้อสอบแล้ว');
      return;
    }

    isHarvesting = true;
    const sweepBtn = shadowRoot.getElementById('batch-sweep-btn');
    if (sweepBtn) sweepBtn.innerText = '⏹️ หยุดการทำงาน';

    const mode = detectQuizMode();
    let questionsToProcess = [];

    if (mode === 'ALL_IN_ONE') {
      // CASE 1: ALL QUESTIONS ARE ALREADY ON THIS ONE PAGE!
      updateStatus('⚡ ตรวจพบข้อสอบแสดงผลหน้าเดียว! กำลังอ่านโจทย์ทั้งหมด...');
      questionsToProcess = await scrapeAllQuestionsOnPage();
      allPageQuestions = questionsToProcess;
    } else {
      // CASE 2: ONE AT A TIME (PAGINATED)
      updateStatus('🔍 กำลังกวาดข้อสอบทีละข้อจากแถบตัวเลข...');
      const navMap = getAllQuestionNavButtons();
      const total = navMap.size > 0 ? navMap.size : 20;
      let prevStem = '';

      for (let qNum = 1; qNum <= total; qNum++) {
        if (!isHarvesting) break;
        updateStatus(`⚡ กำลังกวาดข้อสอบ: ข้อที่ ${qNum}/${total}...`);

        if (qNum > 1) {
          const navBtn = findQuestionNavButton(qNum);
          if (navBtn) {
            navBtn.click();
          } else {
            const nextBtn = Array.from(document.querySelectorAll('button, a')).find(
              (b) => b.innerText.toLowerCase().includes('next') || b.innerText.includes('ถัดไป')
            );
            if (nextBtn) nextBtn.click();
          }
        }

        const q = await waitForActiveQuestion(qNum, prevStem);
        if (q && q.text) {
          prevStem = q.text;
          q.number = qNum;
          questionsToProcess.push(q);
        }
      }
      allPageQuestions = questionsToProcess;
    }

    if (!isHarvesting) return;

    // Filter uncached questions
    const questionsToSolve = [];
    let cacheHitCount = 0;

    questionsToProcess.forEach((q) => {
      const cached = getCachedAnswer(q);
      if (cached) {
        cacheHitCount++;
      } else {
        questionsToSolve.push(q);
      }
    });

    updateStatus(`พบข้อสอบ ${questionsToProcess.length} ข้อ (Cache Hit: ${cacheHitCount} ข้อ, รอส่ง AI: ${questionsToSolve.length} ข้อ)`);

    // If all questions are already in cache
    if (questionsToSolve.length === 0) {
      isHarvesting = false;
      if (sweepBtn) sweepBtn.innerText = '🚀 กวาดโจทย์ทุกข้อ & ส่งวิเคราะห์ทีเดียว';
      updateStatus(`🎉 ทุกข้อ (${questionsToProcess.length} ข้อ) มีคำตอบใน Cache ครบทั้งหมดแล้ว 100%!`);

      if (mode === 'ALL_IN_ONE') {
        applyAllHighlightsOnPage();
      } else {
        findQuestionNavButton(1)?.click();
      }
      return;
    }

    // Send uncached to OpenRouter
    updateStatus(`🚀 ส่ง ${questionsToSolve.length} ข้อที่เหลือไปยัง OpenRouter พร้อมกันใน 1 คำขอ...`);

    const payload = questionsToSolve.map((q, idx) => ({
      index: q.number || idx + 1,
      text: q.text,
      options: q.options.map((o) => ({ index: o.index, text: o.text })),
      images: q.images
    }));

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SOLVE_QUIZ', payload: { questions: payload } }, resolve);
      });

      if (!response || !response.success) {
        isHarvesting = false;
        if (sweepBtn) sweepBtn.innerText = '🚀 กวาดโจทย์ทุกข้อ & ส่งวิเคราะห์ทีเดียว';
        updateStatus(response?.error || 'เกิดข้อผิดพลาดในการส่งวิเคราะห์แบบชุด', true);
        return;
      }

      const answers = response.data.answers || [];
      const batchCache = {};

      questionsToSolve.forEach((q, idx) => {
        const ans =
          answers.find((a) => parseInt(a.question_index) === q.number) ||
          answers.find((a) => parseInt(a.question_index) === idx + 1) ||
          answers[idx];
        if (ans) {
          ans.question_stem = q.text;
          ans.question_number = q.number;

          const textKey = normalizeKey(q.text);
          const numKey = `q_num_${q.number}`;

          batchCache[textKey] = ans;
          batchCache[numKey] = ans;

          answerCache.set(textKey, ans);
          answerCache.set(numKey, ans);
        }
      });

      saveBatchToCache(batchCache);

      isHarvesting = false;
      if (sweepBtn) sweepBtn.innerText = '🚀 กวาดโจทย์ทุกข้อ & ส่งวิเคราะห์ทีเดียว';
      updateStatus(`🎉 วิเคราะห์และบันทึกลง Cache ครบ ${questionsToProcess.length} ข้อเรียบร้อยแล้ว!`);

      // Apply highlights immediately!
      if (mode === 'ALL_IN_ONE') {
        applyAllHighlightsOnPage();
        renderSummaryResults(questionsToProcess);
      } else {
        // Return to question 1 in paginated mode
        const btn1 = findQuestionNavButton(1);
        if (btn1) {
          btn1.click();
          await new Promise((r) => setTimeout(r, 600));
          const firstQ = (await scrapeAllQuestionsOnPage())[0];
          if (firstQ) {
            currentQuestion = firstQ;
            const ans = getCachedAnswer(firstQ);
            if (ans) {
              applySingleHighlight(firstQ, ans);
              renderSingleResult(ans, firstQ, true);
            }
          }
        }
      }
    } catch (err) {
      isHarvesting = false;
      if (sweepBtn) sweepBtn.innerText = '🚀 กวาดโจทย์ทุกข้อ & ส่งวิเคราะห์ทีเดียว';
      updateStatus(err.message, true);
    }
  }

  // --- BATCH AUTO-CLICK (CASCADE DOWN THE PAGE OR ACROSS TABS) ---
  async function runBatchAutoClickAllFromCache() {
    if (isAutoClickingAll) {
      isAutoClickingAll = false;
      updateStatus('🛑 ยกเลิกการคลิกอัตโนมัติแล้ว');
      return;
    }

    if (answerCache.size === 0) {
      updateStatus('⚠️ ยังไม่มีคำตอบใน Cache กรุณากด "วิเคราะห์ข้อสอบ" ก่อน', true);
      return;
    }

    isAutoClickingAll = true;
    const btn = shadowRoot.getElementById('batch-autoclick-btn');
    if (btn) btn.innerText = '⏹️ หยุดการคลิกอัตโนมัติ';

    const mode = detectQuizMode();

    if (mode === 'ALL_IN_ONE') {
      // SINGLE PAGE CASCADE CLICK!
      updateStatus('⚡ กำลังคลิกตอบคำตอบทุกข้อบนหน้านี้...');
      allPageQuestions = await scrapeAllQuestionsOnPage();
      let clickedCount = 0;

      for (let i = 0; i < allPageQuestions.length; i++) {
        if (!isAutoClickingAll) break;
        const q = allPageQuestions[i];

        updateStatus(`⚡ กำลังคลิกตอบ: ข้อที่ ${q.number || i + 1}/${allPageQuestions.length}...`);

        // Smooth scroll into view
        if (q.container) {
          q.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        const ans = getCachedAnswer(q);
        if (ans) {
          const targetOpt = findMatchingOption(q, ans);
          if (targetOpt && targetOpt.targetElement) {
            await performClick(targetOpt.targetElement);
            clickedCount++;
          }
        }

        // Natural human delay between questions
        const delay = Math.floor(Math.random() * 150) + 250;
        await new Promise((r) => setTimeout(r, delay));
      }

      isAutoClickingAll = false;
      if (btn) btn.innerText = '⚡ คลิกเลือกคำตอบทุกข้อจาก Cache';
      updateStatus(`🎉 คลิกเลือกคำตอบครบ ${clickedCount}/${allPageQuestions.length} ข้อเรียบร้อยแล้ว!`);
      applyAllHighlightsOnPage();
    } else {
      // PAGINATED MODE
      updateStatus('🔍 กำลังค้นหารายการข้อสอบเพื่อคลิกตอบทีละข้อ...');
      const navMap = getAllQuestionNavButtons();
      const total = navMap.size > 0 ? navMap.size : 20;
      let clickedCount = 0;

      for (let qNum = 1; qNum <= total; qNum++) {
        if (!isAutoClickingAll) break;
        updateStatus(`⚡ กำลังคลิกตอบ: ข้อที่ ${qNum}/${total}...`);

        const navBtn = findQuestionNavButton(qNum);
        if (navBtn) {
          navBtn.click();
        } else {
          const nextBtn = Array.from(document.querySelectorAll('button, a')).find(
            (b) => b.innerText.toLowerCase().includes('next') || b.innerText.includes('ถัดไป')
          );
          if (nextBtn) nextBtn.click();
        }

        const q = await waitForActiveQuestion(qNum);
        if (q && q.text) {
          const ans = getCachedAnswer(q);
          if (ans) {
            const targetOpt = findMatchingOption(q, ans);
            if (targetOpt && targetOpt.targetElement) {
              await performClick(targetOpt.targetElement);
              clickedCount++;
            }
          }
        }

        const delay = Math.floor(Math.random() * 200) + 350;
        await new Promise((r) => setTimeout(r, delay));
      }

      isAutoClickingAll = false;
      if (btn) btn.innerText = '⚡ คลิกเลือกคำตอบทุกข้อจาก Cache';
      updateStatus(`🎉 คลิกเลือกคำตอบครบ ${clickedCount}/${total} ข้อเรียบร้อยแล้ว!`);
      findQuestionNavButton(1)?.click();
    }
  }

  // --- NAVIGATION HELPERS (FOR PAGINATED MODE) ---
  function getAllQuestionNavButtons() {
    const all = Array.from(document.querySelectorAll('button, [role="button"], a, li'));
    const map = new Map();

    all.forEach((el) => {
      const txt = (el.innerText || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();

      if (/next|prev|submit|ถัดไป|ก่อนหน้า|ส่ง/i.test(txt) || /next|prev|submit/i.test(aria)) {
        return;
      }

      let qNum = null;
      const ariaMatch = aria.match(/question\s*(\d+)/i) || aria.match(/ข้อที่\s*(\d+)/i);
      if (ariaMatch) {
        qNum = parseInt(ariaMatch[1]);
      } else {
        const numMatch = txt.match(/(?:^|[^\d])(\d+)(?:[^\d]|$)/);
        if (numMatch) {
          const n = parseInt(numMatch[1]);
          if (n >= 1 && n <= 100) {
            const inSidebar = el.closest('nav, aside, [class*="nav"], [class*="sidebar"], [class*="rail"], [role="navigation"], ol, ul');
            if (inSidebar || txt.length <= 6) {
              qNum = n;
            }
          }
        }
      }

      if (qNum !== null && !map.has(qNum)) {
        map.set(qNum, el);
      }
    });

    return map;
  }

  function findQuestionNavButton(targetNum) {
    const navMap = getAllQuestionNavButtons();
    if (navMap.has(targetNum)) return navMap.get(targetNum);

    const all = Array.from(document.querySelectorAll('button, [role="button"], a, li'));
    return all.find((el) => {
      const txt = el.innerText.trim();
      const m = txt.match(/(?:^|[^\d])(\d+)(?:[^\d]|$)/);
      return m && parseInt(m[1]) === targetNum && txt.length <= 6;
    });
  }

  async function waitForActiveQuestion(expectedNum, prevStem = '', maxWaitMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const qList = await scrapeAllQuestionsOnPage();
      if (qList.length > 0) {
        const matching = qList.find((q) => q.number === expectedNum);
        if (matching) return matching;

        // If prevStem was provided, make sure the DOM question has changed
        if (prevStem && cleanStem(qList[0].text) === cleanStem(prevStem)) {
          // Still on old question, keep waiting for DOM update
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }

        if (Date.now() - start > 800) return qList[0];
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    const finalQ = await scrapeAllQuestionsOnPage();
    return finalQ[0] || null;
  }

  // --- FLOATING UI (CLOSED SHADOW DOM) ---
  function createFloatingUI() {
    if (document.getElementById('__canvas_ai_host__')) return;

    const host = document.createElement('div');
    host.id = '__canvas_ai_host__';
    host.style.position = 'fixed';
    host.style.bottom = '24px';
    host.style.right = '24px';
    host.style.zIndex = '2147483647';
    document.documentElement.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'closed' });

    chrome.runtime.sendMessage({ action: 'GET_CONFIG' }, (response) => {
      const config = response?.config || {
        model: 'smart-hybrid',
        reasoningEffort: 'low',
        defaultMode: 'highlight'
      };
      currentMode = config.defaultMode || 'highlight';
      renderShadowDOM(shadowRoot, config);
    });
  }

  function renderShadowDOM(root, config) {
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        
        .ai-fab {
          display: flex;
          align-items: center;
          gap: 10px;
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          padding: 12px 20px;
          border-radius: 50px;
          box-shadow: 0 6px 24px rgba(16, 185, 129, 0.45);
          cursor: pointer;
          font-weight: 700;
          font-size: 14px;
          border: 2px solid rgba(255, 255, 255, 0.2);
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          user-select: none;
        }
        .ai-fab:hover {
          transform: translateY(-3px) scale(1.02);
          box-shadow: 0 10px 30px rgba(16, 185, 129, 0.6);
        }
        .ai-badge {
          background: rgba(0, 0, 0, 0.25);
          padding: 2px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
        }

        .ai-drawer {
          display: none;
          position: fixed;
          top: 24px;
          right: 24px;
          bottom: 24px;
          width: 440px;
          max-width: calc(100vw - 48px);
          background: #111827;
          color: #f9fafb;
          border: 1px solid #374151;
          border-radius: 16px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
          flex-direction: column;
          overflow: hidden;
          z-index: 100;
          animation: slideIn 0.2s ease-out;
        }
        @keyframes slideIn {
          from { transform: translateX(40px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .ai-drawer.open { display: flex; }

        .drawer-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          background: #1f2937;
          border-bottom: 1px solid #374151;
        }
        .drawer-title {
          font-size: 16px;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #10b981;
        }
        .close-btn {
          background: transparent;
          border: none;
          color: #9ca3af;
          font-size: 24px;
          cursor: pointer;
          line-height: 1;
        }
        .close-btn:hover { color: white; }

        .drawer-body {
          flex: 1;
          overflow-y: auto;
          padding: 16px 20px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .mode-box {
          background: #1f2937;
          border: 1px solid #374151;
          border-radius: 10px;
          padding: 12px;
        }
        .mode-title {
          font-size: 11px;
          font-weight: 700;
          color: #9ca3af;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .mode-options {
          display: flex;
          gap: 8px;
        }
        .mode-btn {
          flex: 1;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid #4b5563;
          background: #374151;
          color: #d1d5db;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          text-align: center;
          transition: all 0.2s;
        }
        .mode-btn.active {
          background: #065f46;
          border-color: #10b981;
          color: #34d399;
          font-weight: 700;
        }

        .info-pill {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #1e293b;
          border: 1px solid #334155;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 12px;
        }
        .model-tag {
          color: #60a5fa;
          font-family: monospace;
          font-weight: 600;
        }

        .btn-sweep {
          background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
          color: white;
          padding: 14px;
          border: none;
          border-radius: 10px;
          font-weight: 700;
          font-size: 14px;
          cursor: pointer;
          text-align: center;
          box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4);
          transition: transform 0.2s;
        }
        .btn-sweep:hover { transform: translateY(-1px); }

        .btn-autoclick-all {
          background: linear-gradient(135deg, #059669 0%, #047857 100%);
          color: white;
          padding: 13px;
          border: none;
          border-radius: 10px;
          font-weight: 700;
          font-size: 14px;
          cursor: pointer;
          text-align: center;
          box-shadow: 0 4px 14px rgba(5, 150, 105, 0.4);
          transition: transform 0.2s;
        }
        .btn-autoclick-all:hover { transform: translateY(-1px); }

        .btn-primary {
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          padding: 12px;
          border: none;
          border-radius: 8px;
          font-weight: 700;
          font-size: 13px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .btn-primary:hover { opacity: 0.95; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

        .btn-secondary {
          background: #374151;
          color: #e5e7eb;
          padding: 9px;
          border: 1px solid #4b5563;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          text-align: center;
        }
        .btn-secondary:hover { background: #4b5563; }

        .results-container {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .q-card {
          background: #1f2937;
          border: 1px solid #374151;
          border-radius: 8px;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .q-card-header {
          display: flex;
          justify-content: space-between;
          font-size: 14px;
          font-weight: 700;
        }
        .cache-badge {
          background: rgba(59, 130, 246, 0.2);
          border: 1px solid #3b82f6;
          color: #93c5fd;
          padding: 2px 8px;
          border-radius: 6px;
          font-size: 11px;
        }
        .fresh-badge {
          background: rgba(16, 185, 129, 0.2);
          border: 1px solid #10b981;
          color: #6ee7b7;
          padding: 2px 8px;
          border-radius: 6px;
          font-size: 11px;
        }
        .q-stem {
          font-size: 13px;
          color: #e2e8f0;
          line-height: 1.5;
        }
        .q-answer-box {
          background: rgba(16, 185, 129, 0.15);
          border-left: 4px solid #10b981;
          padding: 10px 12px;
          border-radius: 4px;
          margin-top: 4px;
        }
        .q-ans-text {
          font-size: 14px;
          font-weight: 700;
          color: #34d399;
          line-height: 1.4;
        }
        .q-ans-exp {
          font-size: 12px;
          color: #a7f3d0;
          margin-top: 6px;
          line-height: 1.5;
        }

        .status-text {
          font-size: 12px;
          color: #9ca3af;
          text-align: center;
          line-height: 1.4;
        }
        .status-text.error { color: #f87171; }

        .spinner {
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-radius: 50%;
          border-top-color: white;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>

      <button class="ai-fab" id="fab-btn">
        <span>⚡</span>
        <span>AI Assistant</span>
        <span class="ai-badge" id="fab-badge">กำลังสแกน...</span>
      </button>

      <div class="ai-drawer" id="drawer">
        <div class="drawer-header">
          <div class="drawer-title">
            <span>⚡</span>
            <span>Canvas Quiz AI Solver</span>
          </div>
          <button class="close-btn" id="close-drawer">&times;</button>
        </div>

        <div class="drawer-body">
          <button class="btn-primary" id="solve-current-btn" style="padding:14px; font-size:14px; border-radius:10px; background:linear-gradient(135deg, #10b981 0%, #059669 100%); box-shadow:0 4px 14px rgba(16, 185, 129, 0.4);">
            <span>⚡ วิเคราะห์ข้อนี้ทันที (Solve Current Question)</span>
          </button>

          <button class="btn-sweep" id="batch-sweep-btn">
            <span>🚀 กวาดโจทย์ทุกข้อ & ส่งวิเคราะห์ทีเดียว</span>
          </button>

          <button class="btn-autoclick-all" id="batch-autoclick-btn">
            <span>⚡ คลิกเลือกคำตอบทุกข้อจาก Cache</span>
          </button>

          <div class="mode-box">
            <div class="mode-title">โหมดการเลือกคำตอบ</div>
            <div class="mode-options">
              <button class="mode-btn ${currentMode === 'highlight' ? 'active' : ''}" id="mode-highlight">
                🟢 เรืองแสงช้อยส์ (แนะนำ)
              </button>
              <button class="mode-btn ${currentMode === 'autoclick' ? 'active' : ''}" id="mode-autoclick">
                ⚡ ออโต้คลิกคำตอบ
              </button>
            </div>
          </div>

          <div class="info-pill">
            <span style="color:#9ca3af;">โมเดล AI:</span>
            <span class="model-tag">${config.model === 'smart-hybrid' ? '⚡ Smart Hybrid (Jev + Grok)' : (config.model + ' (' + config.reasoningEffort + ')')}</span>
          </div>

          <div class="status-text" id="status-display">พร้อมทำงาน • กดปุ่มสีเขียวเพื่อวิเคราะห์ข้อนี้ทันที</div>

          <div class="results-container" id="results-box"></div>

          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
            <button class="btn-secondary" id="reapply-highlight-btn" style="background:#065f46; color:#a7f3d0; border-color:#10b981;">
              🟢 เน้นสีช้อยส์ทุกข้อบนหน้าจอซ้ำ
            </button>
            <button class="btn-secondary" id="clear-cache-btn" style="background:#451a03; color:#fde68a; border-color:#b45309;">
              🧹 ล้างคำตอบใน Cache ทั้งหมด
            </button>
          </div>
        </div>
      </div>
    `;

    setupEventHandlers(root);
  }

  function setupEventHandlers(root) {
    const fabBtn = root.getElementById('fab-btn');
    const drawer = root.getElementById('drawer');
    const closeBtn = root.getElementById('close-drawer');
    const solveCurrentBtn = root.getElementById('solve-current-btn');
    const modeHighlight = root.getElementById('mode-highlight');
    const modeAutoclick = root.getElementById('mode-autoclick');
    const batchSweepBtn = root.getElementById('batch-sweep-btn');
    const batchAutoclickBtn = root.getElementById('batch-autoclick-btn');
    const reapplyBtn = root.getElementById('reapply-highlight-btn');
    const clearCacheBtn = root.getElementById('clear-cache-btn');

    fabBtn.onclick = () => drawer.classList.toggle('open');
    closeBtn.onclick = () => drawer.classList.remove('open');

    if (solveCurrentBtn) solveCurrentBtn.onclick = () => solveCurrentQuestionOnly();

    modeHighlight.onclick = () => {
      currentMode = 'highlight';
      modeHighlight.classList.add('active');
      modeAutoclick.classList.remove('active');
    };
    modeAutoclick.onclick = () => {
      currentMode = 'autoclick';
      modeAutoclick.classList.add('active');
      modeHighlight.classList.remove('active');
    };

    batchSweepBtn.onclick = () => runBatchSweepAndSolve();
    batchAutoclickBtn.onclick = () => runBatchAutoClickAllFromCache();
    reapplyBtn.onclick = () => {
      const mode = detectQuizMode();
      if (mode === 'ALL_IN_ONE') {
        applyAllHighlightsOnPage();
      } else if (currentQuestion) {
        const ans = getCachedAnswer(currentQuestion);
        if (ans) applySingleHighlight(currentQuestion, ans);
      }
    };

    clearCacheBtn.onclick = () => {
      answerCache.clear();
      chrome.runtime.sendMessage({ action: 'CLEAR_CACHE' });
      clearHighlights();
      const container = root.getElementById('results-box');
      if (container) container.innerHTML = '';
      updateStatus('🧹 ล้างข้อมูล Cache คำตอบเรียบร้อยแล้ว');
    };
  }

  function updateStatus(msg, isError = false) {
    if (!shadowRoot) return;
    const el = shadowRoot.getElementById('status-display');
    if (el) {
      el.className = isError ? 'status-text error' : 'status-text';
      el.innerText = msg;
    }
  }

  function updateBadgeInfo(count, mode) {
    if (!shadowRoot) return;
    const badge = shadowRoot.getElementById('fab-badge');
    if (badge) {
      badge.innerText = mode === 'ALL_IN_ONE' ? `${count} ข้อ (หน้าเดียว)` : `${count} ข้อ (ทีละข้อ)`;
    }
  }

  function renderSingleResult(ans, q, isCacheHit = false) {
    if (!shadowRoot || !ans) return;
    const matchedOpt = findMatchingOption(q, ans);
    const optLabel = matchedOpt ? matchedOpt.text : (ans.selected_option_text || `ตัวเลือก [${ans.selected_option_index}]`);
    const container = shadowRoot.getElementById('results-box');
    container.innerHTML = `
      <div class="q-card">
        <div class="q-card-header">
          <span style="color:#10b981;">ข้อที่ ${q.number || ans.question_index || 1}</span>
          <div style="display:flex; gap:6px; align-items:center;">
            ${isCacheHit ? '<span class="cache-badge">⚡ Cache Hit</span>' : '<span class="fresh-badge">✨ วิเคราะห์สด</span>'}
            <span style="color:#6ee7b7; font-size:11px;">${ans.confidence || '99%'}</span>
          </div>
        </div>
        <div class="q-stem">${q.text}</div>
        <div class="q-answer-box">
          <div class="q-ans-text">✓ คำตอบ: ${optLabel}</div>
          <div class="q-ans-exp">💡 <b>เหตุผล:</b> ${ans.explanation || '-'}</div>
        </div>
      </div>
    `;
  }

  function renderSummaryResults(questions) {
    if (!shadowRoot) return;
    const container = shadowRoot.getElementById('results-box');
    container.innerHTML = '';

    questions.forEach((q) => {
      const ans = getCachedAnswer(q);
      if (!ans) return;

      const matchedOpt = findMatchingOption(q, ans);
      const optLabel = matchedOpt ? matchedOpt.text : (ans.selected_option_text || `ตัวเลือก [${ans.selected_option_index}]`);

      const card = document.createElement('div');
      card.className = 'q-card';
      card.innerHTML = `
        <div class="q-card-header">
          <span style="color:#10b981;">ข้อที่ ${q.number || ans.question_index || 1}</span>
          <span class="cache-badge">✓ พร้อมส่ง</span>
        </div>
        <div class="q-stem">${q.text}</div>
        <div class="q-answer-box">
          <div class="q-ans-text">✓ คำตอบ: ${optLabel}</div>
          <div class="q-ans-exp">💡 ${ans.explanation || '-'}</div>
        </div>
      `;
      container.appendChild(card);
    });
  }

  // --- MESSAGE DISPATCHER (FROM POPUP & SERVICE WORKER) ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'TRIGGER_SCRAPE' || msg.action === 'SOLVE_CURRENT') {
      const mode = detectQuizMode();
      if (mode === 'ALL_IN_ONE') {
        runBatchSweepAndSolve();
      } else {
        solveCurrentQuestionOnly();
      }
      sendResponse({ success: true });
    } else if (msg.action === 'TRIGGER_BATCH') {
      runBatchSweepAndSolve();
      sendResponse({ success: true });
    } else if (msg.action === 'OPEN_PANEL') {
      if (shadowRoot) {
        const drawer = shadowRoot.getElementById('drawer');
        if (drawer) drawer.classList.add('open');
      }
      sendResponse({ success: true });
    } else if (msg.action === 'APPLY_ANSWERS_IN_FRAME') {
      refreshQuestionsOnPage();
      sendResponse({ success: true });
    }
    return true;
  });
})();
