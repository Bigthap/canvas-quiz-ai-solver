// Canvas Quiz AI Solver - Options Page Logic

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelInput = document.getElementById('model');
  const reasoningSelect = document.getElementById('reasoningEffort');
  const defaultModeSelect = document.getElementById('defaultMode');
  const form = document.getElementById('settings-form');
  const toast = document.getElementById('toast');

  // Load existing settings
  chrome.storage.local.get(
    ['openRouterApiKey', 'model', 'reasoningEffort', 'defaultMode'],
    (res) => {
      if (res.openRouterApiKey) apiKeyInput.value = res.openRouterApiKey;
      if (res.model) modelInput.value = res.model;
      if (res.reasoningEffort) reasoningSelect.value = res.reasoningEffort;
      if (res.defaultMode) defaultModeSelect.value = res.defaultMode;
    }
  );

  // Save settings
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim() || 'openai/gpt-5.6-luna';
    const reasoningEffort = reasoningSelect.value;
    const defaultMode = defaultModeSelect.value;

    chrome.storage.local.set(
      {
        openRouterApiKey: apiKey,
        model: model,
        reasoningEffort: reasoningEffort,
        defaultMode: defaultMode
      },
      () => {
        toast.style.display = 'block';
        setTimeout(() => {
          toast.style.display = 'none';
        }, 2500);
      }
    );
  });
});
