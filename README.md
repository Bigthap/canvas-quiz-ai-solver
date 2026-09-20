# Canvas Quiz AI Solver

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeSafe AI Compatible](https://img.shields.io/badge/Architecture-TypeSafe%20System%20One%20Ready-E551BA.svg)](https://typesafe.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> High-performance Chrome Extension for Canvas LMS Quizzes (Classic & New Quizzes/Learnosity), engineered with DOM-order scraping, text-first option matching, and a roadmap toward deterministic **System One (TypeSafe Jev)** decision primitives.

---

## 🎯 Executive Overview & Motivation

Modern Learning Management Systems (LMS) like **Canvas** deliver assessments either through all-in-one scrollable pages or multi-page paginated flows. Traditional AI tools attempt to solve multiple-choice questions by passing prompts to general-purpose, text-generative Large Language Models (LLMs).

However, using generative LLMs for machine-facing decisions introduces severe limitations:
1. **High Latency (3–8s):** Generative autoregressive models waste time sequentially generating tokens, markdown backticks, and formatting boilerplate.
2. **Parsing & Formatting Failures:** Forcing text-based models to produce strict JSON frequently triggers syntax errors, truncated objects, or hallucinations.
3. **Excessive Compute & Cost:** Paying for hundreds of output tokens when the application only needs an integer choice or categorical classification.

### The Paradigm Shift: Why TypeSafe "System One" AI?

This project is structured specifically to adopt **TypeSafe's System One model (Jev)**. 
Instead of coercing a conversational model into generating JSON, **Jev evaluates structured states and typed questions directly**:

```
[DOM Question State & Options] ──▶ TypeSafe Jev (Choice Primitive) ──▶ { choice, probabilities, confidence }
                                                                         ▲ (Sub-second, calibrated, zero-parsing)
```

By leveraging TypeSafe's `Choice` primitive, decision latency drops from seconds to **sub-500ms**, token costs decrease by **90%+**, and confidence scores can be used architecturally to drive automated workflows.

---

## 🏗️ Technical Architecture

The extension is implemented entirely in native JavaScript following Chrome Extension **Manifest V3** best practices:

```
canvas_ai_extension/
├── manifest.json              # Extension metadata, MV3 permissions & host matching
├── background/
│   └── service-worker.js      # API gateway, batch cache coordinator, cross-frame message router
├── content/
│   └── content.js             # Dual-engine DOM scraper, matching logic, closed Shadow DOM UI
├── popup/
│   ├── popup.html             # Toolbar popup interface
│   └── popup.js               # Quick status check and trigger actions
├── options/
│   ├── options.html           # Settings UI (API keys, models, reasoning parameters)
│   └── options.js             # Storage management via chrome.storage.local
└── icons/                     # Extension branding icons
```

### Key Modules & Capabilities

### 1. Dual-Engine DOM Scraper (`content/content.js`)
* **Quiz Mode Detection:** Automatically inspects input radio group distributions to differentiate between `ALL_IN_ONE` (Classic Quizzes) and `ONE_AT_A_TIME` (New Quizzes / Learnosity).
* **Document-Order Sorting:** Uses `Node.compareDocumentPosition` to guarantee that extracted questions and options strictly reflect the visual, vertical order of the document, eliminating index misalignment.
* **Multimodal Asset Extraction:** Dynamically serializes DOM `<img>` elements into Base64 data URLs for questions containing mathematical graphs or diagrams.

### 2. Text-First Option Matching Engine
Eliminates option index shifts (a common issue when Canvas shuffles choices dynamically):
* **Tier 1 (Exact Match):** Normalized verbatim text comparison.
* **Tier 2 (Substring Containment):** Handles truncated or whitespace-padded text.
* **Tier 3 (Bigram Similarity):** Sørensen–Dice coefficient ($\ge 0.50$) for slight typographical or OCR discrepancies.
* **Tier 4 (Index Fallback):** Safe 0-based boundary fallback.

### 3. Isolated Floating UI
* Built inside a **Closed Shadow DOM (`attachShadow({ mode: 'closed' })`)** to ensure host webpage CSS rules (Canvas LMS themes) cannot bleed into or distort the extension interface.

### 4. Non-Destructive Actions
* **Glow Highlight Mode (Default):** Highlights target answers with an emerald green glow (`box-shadow: 0 0 20px rgba(16, 185, 129, 0.95)`), keeping Canvas audit trails completely untouched.
* **Human-like Auto-Click Mode:** Emulates full user event chains (`pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`) with jittered human timing delays.

---

## ⚡ Live Architecture: Smart Hybrid (Jev-1.13 + Grok 4.6 Fallback)

The extension now features **Smart Hybrid** as its default solving engine:

1. **Frontline Engine (`typesafe/jev-1.13` via `/api/alpha/decisions`)**:
   - Takes all exam questions in a single high-speed call.
   - Evaluates choice probabilities directly without autoregressive text generation overhead.
   - Responds in ~2.7s for 300 questions with 100% typed stability.
2. **Confidence Filter & Dynamic Fallback (`x-ai/grok-4.6` via Chat Completions)**:
   - Evaluates Jev decision confidence. If any question has `confidence < 0.80` (~8–14% of questions), it dynamically routes only those edge cases to `x-ai/grok-4.6` with compact reasoning (`effort: "low"`).
   - Achieves **84.0% accuracy** on the hardest academic questions, pulling overall 300-question accuracy to **95.67%**.

### 📊 Benchmark Scoreboard (300 Questions MMLU Academic Dataset)

| Metric | Pure Jev-1.13 | Pure Luna High | **Smart Hybrid (Jev + Grok 4.6)** 🏆 |
| :--- | :---: | :---: | :---: |
| **Accuracy** | 92.67% (278/300) | 80.00% (240/300)* | **95.67% (287/300)** |
| **Total Wall Time** | **2.73s** (~9.1 ms/q) | 5.66s (~18.9 ms/q) | **4.51s** (~15.0 ms/q) |
| **Total Cost (300 Qs)** | **$0.0027** (~0.09 THB) | $0.0643 (~2.25 THB) | **$0.0292** (~1.02 THB) |
| **Cost Multiplier** | 30.8x cheaper | Baseline | **55% cheaper than pure LLM** |
| **Format Reliability** | 100% (Zero Parse Error) | 83.3% (JSON desync risk) | **100% (Zero Parse Error)** |

*\*Note on Pure Luna:* Suffered a batch JSON schema desync on 50-question batches. Smart Hybrid prevents this completely by routing only small batches of edge cases to LLMs.

## 🚀 Installation & Setup

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/Bigthap/canvas-quiz-ai-solver.git
   ```

2. **Load into Google Chrome:**
   * Navigate to `chrome://extensions/`
   * Enable **Developer mode** (top-right toggle).
   * Click **Load unpacked** and select the cloned `canvas-quiz-ai-solver` directory.

3. **Configure Settings:**
   * Click the extension icon in Chrome or right-click $\rightarrow$ **Options**.
   * Enter your API Key and configure your preferred default mode (Highlight or Auto-Click).

---

## 🛡️ License

This project is licensed under the [MIT License](LICENSE).
