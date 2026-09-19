// Canvas Quiz AI Solver - Popup Logic

document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const modelVal = document.getElementById('model-val');
  const modeVal = document.getElementById('mode-val');
  const effortVal = document.getElementById('effort-val');
  const triggerSolveBtn = document.getElementById('trigger-solve-btn');
  const openPanelBtn = document.getElementById('open-panel-btn');
  const openOptionsBtn = document.getElementById('open-options-btn');
  const reloadBtn = document.getElementById('reload-tab-btn');

  // Load config
  chrome.storage.local.get(
    ['openRouterApiKey', 'model', 'reasoningEffort', 'defaultMode'],
    (res) => {
      const hasKey = Boolean(res.openRouterApiKey);
      if (hasKey) {
        badge.className = 'status-badge ready';
        statusText.innerText = 'พร้อมใช้งาน (API Key ตั้งค่าแล้ว)';
      } else {
        badge.className = 'status-badge missing';
        statusText.innerText = 'ยังไม่ได้ตั้งค่า API Key';
      }

      modelVal.innerText = res.model || 'openai/gpt-5.6-luna';
      modeVal.innerText = res.defaultMode === 'autoclick' ? 'Auto-Click' : 'Glow Highlight';
      effortVal.innerText = res.reasoningEffort || 'high';
    }
  );

  // Trigger Solve directly from popup
  triggerSolveBtn.onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_SCRAPE' }, () => {
          window.close();
        });
      }
    });
  };

  // Open Panel
  openPanelBtn.onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'OPEN_PANEL' }, () => {
          window.close();
        });
      }
    });
  };

  openOptionsBtn.onclick = () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options/options.html'));
    }
  };

  reloadBtn.onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.reload(tabs[0].id);
        window.close();
      }
    });
  };
});
