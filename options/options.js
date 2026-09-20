// Canvas Quiz AI Solver - Options Page Logic

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelPresetSelect = document.getElementById('modelPreset');
  const customModelGroup = document.getElementById('customModelGroup');
  const customModelInput = document.getElementById('customModelInput');
  const reasoningSelect = document.getElementById('reasoningEffort');
  const defaultModeSelect = document.getElementById('defaultMode');
  const form = document.getElementById('settings-form');
  const toast = document.getElementById('toast');

  const KNOWN_PRESETS = ['smart-hybrid', 'openai/gpt-5.6-luna', 'typesafe/jev-1.13', 'x-ai/grok-4.6'];

  function updateCustomVisibility() {
    if (modelPresetSelect.value === 'custom') {
      customModelGroup.style.display = 'block';
      customModelInput.required = true;
    } else {
      customModelGroup.style.display = 'none';
      customModelInput.required = false;
    }
  }

  modelPresetSelect.addEventListener('change', updateCustomVisibility);

  // Load existing settings
  chrome.storage.local.get(
    ['openRouterApiKey', 'model', 'reasoningEffort', 'defaultMode'],
    (res) => {
      if (res.openRouterApiKey) apiKeyInput.value = res.openRouterApiKey;
      const currentModel = res.model || 'smart-hybrid';
      if (KNOWN_PRESETS.includes(currentModel)) {
        modelPresetSelect.value = currentModel;
        customModelGroup.style.display = 'none';
      } else {
        modelPresetSelect.value = 'custom';
        customModelInput.value = currentModel;
        customModelGroup.style.display = 'block';
      }
      reasoningSelect.value = res.reasoningEffort || 'low';
      if (res.defaultMode) defaultModeSelect.value = res.defaultMode;
    }
  );

  // Save settings
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const apiKey = apiKeyInput.value.trim();
    let model = modelPresetSelect.value;
    if (model === 'custom') {
      model = customModelInput.value.trim() || 'smart-hybrid';
    }
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
