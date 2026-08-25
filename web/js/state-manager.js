import { devLog, devWarn } from './config.js';
import screenshotService from './screenshot-service.js';

export class StateManager {
    constructor() {
        this.appState = {
            onboardingData: {},
            socket: null,
            aiProviders: [],
            selectedProvider: {
                name: null,
                model: null,
            },
            selectedSecondaryProvider: {
                name: null,
                model: null,
            },
            selectedVisionProvider: {
                name: null,
                model: null,
            },
            selectedSecondaryVisionProvider: {
                name: null,
                model: null,
            },
            selectedLanguages: [],
            currentPreset: null,
            availablePresets: [],
            systemStatus: null,
            visionMode: {
                isActive: false,
                screenshotQueue: [],
                maxScreenshots: 4,
                currentVisionProvider: 'primary',
                lastSwitchTime: 0,
                switchCooldown: 1000
            }
        };
        
        // DOM form elements
        this.onboardingForm = {};
        this.initializeFormElements();

        // Vision mode debouncing
        this.lastVisionToggleTime = 0;
        this.visionToggleCooldown = 500;
        this.lastScreenshotTime = 0;
        this.screenshotCooldown = 300;
    }

    initializeFormElements() {
        // Initialize DOM elements safely
        this.onboardingForm = {
            name: document.getElementById('user-name'),
            company: document.getElementById('user-company'),
            role: document.getElementById('user-role'),
            resume: document.getElementById('user-resume'),
            focusCheckboxes: document.querySelectorAll('input[name="focus"]'),
            objectives: document.getElementById('user-objectives'),
            providerSelect: document.getElementById('ai-provider-select'),
            modelSelect: document.getElementById('ai-model-select'),
            secondaryProviderSelect: document.getElementById('ai-secondary-provider-select'),
            secondaryModelSelect: document.getElementById('ai-secondary-model-select'),
            visionProviderSelect: document.getElementById('vision-provider-select'),
            visionModelSelect: document.getElementById('vision-model-select'),
            visionSecondaryProviderSelect: document.getElementById('vision-secondary-provider-select'),
            visionSecondaryModelSelect: document.getElementById('vision-secondary-model-select'),
            languageCheckboxes: document.querySelectorAll('input[name="language"]'),
        };
    }

    getState() {
        return this.appState;
    }

    updateState(updates) {
        Object.assign(this.appState, updates);
    }

    setSocket(socket) {
        this.appState.socket = socket;
    }

    handleOnboarding() {
        const requiredFields = {
            'user-name': 'Name',
            'user-company': 'Company',
            'user-role': 'Role',
            'user-resume': 'Resume',
            'ai-provider-select': 'AI Provider',
            'ai-model-select': 'AI Model'
        };

        let allValid = true;

        for (const [id, name] of Object.entries(requiredFields)) {
            const element = document.getElementById(id);
            if (!element || !element.value) {
                alert(`${name} is a required field.`);
                allValid = false;
                break;
            }
        }

        const focusCheckboxes = Array.from(this.onboardingForm.focusCheckboxes || []).filter(cb => cb.checked);
        if (focusCheckboxes.length === 0) {
            alert('Please select at least one Interview Focus.');
            allValid = false;
        }

        if (!allValid) return false;

        // Validate secondary provider selection
        const secondaryProvider = this.onboardingForm.secondaryProviderSelect?.value || '';
        const secondaryModel = this.onboardingForm.secondaryModelSelect?.value || '';
        
        if ((secondaryProvider && !secondaryModel) || (!secondaryProvider && secondaryModel)) {
            alert('If you select a secondary provider, you must also select a secondary model (or leave both empty).');
            return false;
        }

        if (secondaryProvider && secondaryModel) {
            const primaryProvider = this.onboardingForm.providerSelect?.value || '';
            const primaryModel = this.onboardingForm.modelSelect?.value || '';
            
            if (primaryProvider === secondaryProvider && primaryModel === secondaryModel) {
                alert('Primary and secondary AI models cannot be the same. Please select different models.');
                return false;
            }
        }

        // Validate vision providers
        const visionProvider = this.onboardingForm.visionProviderSelect?.value || '';
        const visionModel = this.onboardingForm.visionModelSelect?.value || '';
        
        if ((visionProvider && !visionModel) || (!visionProvider && visionModel)) {
            alert('If you select a vision provider, you must also select a vision model (or leave both empty).');
            return false;
        }

        const secondaryVisionProvider = this.onboardingForm.visionSecondaryProviderSelect?.value || '';
        const secondaryVisionModel = this.onboardingForm.visionSecondaryModelSelect?.value || '';
        
        if ((secondaryVisionProvider && !secondaryVisionModel) || (!secondaryVisionProvider && secondaryVisionModel)) {
            alert('If you select a secondary vision provider, you must also select a secondary vision model (or leave both empty).');
            return false;
        }

        // Store validated data
        const focus = focusCheckboxes.map(cb => cb.value);
        const selectedLanguages = Array.from(this.onboardingForm.languageCheckboxes || [])
            .filter(cb => cb.checked)
            .map(cb => cb.value);

        this.appState.onboardingData = {
            name: this.onboardingForm.name?.value || '',
            company: this.onboardingForm.company?.value || '',
            role: this.onboardingForm.role?.value || '',
            resume: this.onboardingForm.resume?.value || '',
            focus: focus,
            objectives: this.onboardingForm.objectives?.value || '',
        };

        this.appState.selectedProvider.name = this.onboardingForm.providerSelect?.value || null;
        this.appState.selectedProvider.model = this.onboardingForm.modelSelect?.value || null;
        this.appState.selectedSecondaryProvider.name = secondaryProvider || null;
        this.appState.selectedSecondaryProvider.model = secondaryModel || null;
        this.appState.selectedVisionProvider.name = visionProvider || null;
        this.appState.selectedVisionProvider.model = visionModel || null;
        this.appState.selectedSecondaryVisionProvider.name = secondaryVisionProvider || null;
        this.appState.selectedSecondaryVisionProvider.model = secondaryVisionModel || null;
        this.appState.selectedLanguages = selectedLanguages;

        devLog("Onboarding data captured:", this.appState);
        return true;
    }

    isLiveInterviewActive() {
        const currentView = document.querySelector('.view.active');
        return currentView && currentView.id === 'live-view';
    }

    // Vision Mode Functions

    /**
     * Images the selected vision provider accepts in one request.
     * Returns undefined when the provider does not declare a limit, which
     * leaves the screenshot queue on its default cap.
     */
    _visionMaxImages(providerName) {
        const provider = (this.appState.aiProviders || []).find(p => p.name === providerName);
        return provider?.maxImages;
    }

    toggleVisionMode() {
        console.log('🎮 toggleVisionMode called (could be from global hotkey)');
        
        // Debounce rapid calls
        const now = Date.now();
        if (now - this.lastVisionToggleTime < this.visionToggleCooldown) {
            console.log('🎮 Ignoring rapid vision mode toggle (debounced)');
            return false;
        }
        this.lastVisionToggleTime = now;
        
        if (!this.isLiveInterviewActive()) {
            console.warn('⚠️ Vision mode only available during live interview');
            if (window.presetManager) {
                presetManager.showErrorNotification('Start the interview first before using vision mode');
            } else {
                alert('Please start the interview before using vision mode');
            }
            return false;
        }
        
        // If primary vision provider is not explicitly set, try to fall back to active primary AI provider if it supports vision
        if (!this.appState.selectedVisionProvider.name || !this.appState.selectedVisionProvider.model) {
            const primaryAiProvider = (this.appState.aiProviders || []).find(p => p.name === this.appState.selectedProvider.name);
            if (primaryAiProvider && primaryAiProvider.supportsVision && primaryAiProvider.visionModels?.length > 0) {
                const defaultModel = primaryAiProvider.defaultVisionModel || primaryAiProvider.visionModels[0];
                const modelName = typeof defaultModel === 'string' ? defaultModel : defaultModel?.modelName;
                this.appState.selectedVisionProvider = {
                    name: primaryAiProvider.name,
                    model: modelName
                };
            }
        }

        if (!this.appState.selectedVisionProvider.name || !this.appState.selectedVisionProvider.model) {
            console.warn('⚠️ Vision mode requires a vision model to be configured');
            if (window.presetManager) {
                presetManager.showErrorNotification('Vision model not configured. Please set up a vision provider in onboarding.');
            } else {
                alert('Vision model not configured. Please configure a vision provider in onboarding.');
            }
            return false;
        }
        
        this.appState.visionMode.isActive = !this.appState.visionMode.isActive;
        
        if (this.appState.visionMode.isActive) {
            let currentProvider = this.appState.visionMode.currentVisionProvider === 'secondary'
                ? this.appState.selectedSecondaryVisionProvider
                : this.appState.selectedVisionProvider;
                
            if (!currentProvider || !currentProvider.name || !currentProvider.model) {
                currentProvider = this.appState.selectedVisionProvider;
            }

            screenshotService.setVisionConfig(currentProvider.name, currentProvider.model, this._visionMaxImages(currentProvider.name));
            screenshotService.setProgrammingLanguages(this.appState.selectedLanguages);
            screenshotService.showVisionMode(true);
            
            if (window.muteManager) {
                muteManager.setUniversalMute(true);
            }
            
            devLog('👁️ Vision mode activated (global hotkey)');
            console.log('👁️ Vision mode activated - Audio processing paused');
        } else {
            screenshotService.showVisionMode(false);
            
            if (window.muteManager) {
                muteManager.setUniversalMute(false);
            }
            
            devLog('👁️ Vision mode deactivated (global hotkey)');
            console.log('👁️ Vision mode deactivated - Audio processing resumed');
        }
        
        return this.appState.visionMode.isActive;
    }

    switchVisionModel() {
        devLog('🔄 switchVisionModel called');

        if (!this.isLiveInterviewActive()) {
            const msg = 'Vision model can only be switched during a live interview.';
            devWarn(msg);
            if (window.presetManager) presetManager.showErrorNotification(msg);
            return false;
        }

        if (!this.appState.visionMode.isActive) {
            const msg = 'Vision model switching is only available in Vision Mode (Alt+V).';
            devWarn(msg);
            if (window.presetManager) presetManager.showErrorNotification(msg);
            return false;
        }

        const now = Date.now();
        if (now - this.appState.visionMode.lastSwitchTime < this.appState.visionMode.switchCooldown) {
            devLog('🔄 Vision model switch cooldown active, ignoring.');
            return false;
        }

        // Build list of available vision candidates
        const availableCandidates = [];
        const seenKeys = new Set();

        const addCandidate = (providerName, modelName, label) => {
            if (!providerName || !modelName) return;
            const key = `${providerName}::${modelName}`;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                availableCandidates.push({ name: providerName, model: modelName, label });
            }
        };

        // 1. Configured Primary Vision Provider
        if (this.appState.selectedVisionProvider?.name && this.appState.selectedVisionProvider?.model) {
            addCandidate(this.appState.selectedVisionProvider.name, this.appState.selectedVisionProvider.model, 'Primary (1°)');
        }

        // 2. Configured Secondary Vision Provider
        if (this.appState.selectedSecondaryVisionProvider?.name && this.appState.selectedSecondaryVisionProvider?.model) {
            addCandidate(this.appState.selectedSecondaryVisionProvider.name, this.appState.selectedSecondaryVisionProvider.model, 'Secondary (2°)');
        }

        // 3. All other providers in aiProviders that support vision
        (this.appState.aiProviders || []).forEach(p => {
            if (p.supportsVision && p.visionModels?.length > 0) {
                const defaultModel = p.defaultVisionModel || p.visionModels[0];
                const modelName = typeof defaultModel === 'string' ? defaultModel : defaultModel?.modelName;
                if (modelName) {
                    addCandidate(p.name, modelName, p.name);
                }
            }
        });

        if (availableCandidates.length <= 1) {
            const msg = 'No additional vision models available to switch to.';
            devWarn(msg);
            if (window.presetManager) presetManager.showErrorNotification(msg);
            return false;
        }

        this.appState.visionMode.lastSwitchTime = now;

        // Find current candidate index
        const currentConfig = screenshotService.visionConfig;
        let currentIndex = -1;
        if (currentConfig && currentConfig.provider && currentConfig.model) {
            currentIndex = availableCandidates.findIndex(c => c.name === currentConfig.provider && c.model === currentConfig.model);
        }

        const nextIndex = (currentIndex + 1) % availableCandidates.length;
        const nextCandidate = availableCandidates[nextIndex];

        // Update current vision provider state
        if (nextCandidate.name === this.appState.selectedVisionProvider?.name) {
            this.appState.visionMode.currentVisionProvider = 'primary';
        } else if (nextCandidate.name === this.appState.selectedSecondaryVisionProvider?.name) {
            this.appState.visionMode.currentVisionProvider = 'secondary';
        } else {
            this.appState.visionMode.currentVisionProvider = nextCandidate.name;
        }

        screenshotService.setVisionConfig(nextCandidate.name, nextCandidate.model, this._visionMaxImages(nextCandidate.name));
        screenshotService.updateQueueUI();

        const message = `Switched Vision Model: ${nextCandidate.name} (${nextCandidate.model})`;
        if (window.presetManager) {
            presetManager.showSuccessNotification(message);
        }

        devLog(`🔄 Switched vision model to ${nextCandidate.name} (${nextCandidate.model})`);
        return true;
    }

    // Screenshot Functions
    async captureScreenshot() {
        console.log('🎮 captureScreenshot called (could be from global hotkey)');
        
        const now = Date.now();
        if (now - this.lastScreenshotTime < this.screenshotCooldown) {
            console.log('🎮 Ignoring rapid screenshot capture (debounced)');
            return false;
        }
        this.lastScreenshotTime = now;
        
        if (!this.isLiveInterviewActive()) {
            console.warn('⚠️ Screenshots only available during live interview');
            if (window.presetManager) {
                presetManager.showErrorNotification('Start the interview first before taking screenshots');
            } else {
                alert('Please start the interview before taking screenshots');
            }
            return false;
        }
        
        if (!this.appState.visionMode.isActive) {
            console.warn('⚠️ Screenshots can only be taken in vision mode - use Alt+V to enter vision mode first');
            if (window.presetManager) {
                presetManager.showErrorNotification('Enter vision mode first (Alt+V) before taking screenshots');
            } else {
                alert('Enter vision mode first (Alt+V) before taking screenshots');
            }
            return false;
        }
        
        console.log('📸 Taking screenshot via global hotkey');
        return await screenshotService.captureScreenshot();
    }

    async processScreenshots() {
        console.log('🎮 processScreenshots called (could be from global hotkey)');
        
        if (!this.isLiveInterviewActive()) {
            console.warn('⚠️ Screenshot processing only available during live interview');
            if (window.presetManager) {
                presetManager.showErrorNotification('Start the interview first before processing screenshots');
            } else {
                alert('Please start the interview before processing screenshots');
            }
            return false;
        }
        
        if (!this.appState.visionMode.isActive) {
            console.warn('⚠️ Screenshots can only be processed in vision mode - use Alt+V to enter vision mode first');
            if (window.presetManager) {
                presetManager.showErrorNotification('Enter vision mode first (Alt+V) before processing screenshots');
            } else {
                alert('Enter vision mode first (Alt+V) before processing screenshots');
            }
            return false;
        }
        
        console.log('🔄 Processing screenshots via global hotkey');
        return await screenshotService.processQueue();
    }

    async resetScreenshotQueue() {
        console.log('🎮 resetScreenshotQueue called (could be from global hotkey)');
        
        if (!this.isLiveInterviewActive()) {
            console.warn('⚠️ Screenshot queue reset only available during live interview');
            if (window.presetManager) {
                presetManager.showErrorNotification('Start the interview first before resetting screenshot queue');
            } else {
                alert('Please start the interview before resetting screenshot queue');
            }
            return false;
        }
        
        if (!this.appState.visionMode.isActive) {
            console.warn('⚠️ Screenshot queue can only be reset in vision mode - use Alt+V to enter vision mode first');
            if (window.presetManager) {
                presetManager.showErrorNotification('Enter vision mode first (Alt+V) before resetting screenshot queue');
            } else {
                alert('Enter vision mode first (Alt+V) before resetting screenshot queue');
            }
            return false;
        }
        
        console.log('🗑️ Resetting screenshot queue via global hotkey');
        screenshotService.clearQueue();
        return true;
    }

    // Audio Toggle Functions
    toggleMicMute() {
        console.log('🎮 toggleMicMute called (could be from global hotkey)');
        
        if (!this.isLiveInterviewActive()) {
            console.warn('⚠️ Microphone mute only available during live interview');
            if (window.presetManager) {
                presetManager.showErrorNotification('Start the interview first before using microphone controls');
            } else {
                alert('Please start the interview before using microphone controls');
            }
            return false;
        }
        
        if (window.muteManager) {
            const currentStatus = muteManager.getMuteStatus();
            const newMicStatus = !currentStatus.microphone;
            muteManager.setMicrophoneMute(newMicStatus);
            
            const status = newMicStatus ? 'muted' : 'unmuted';
            console.log(`🎤 Microphone ${status} via global hotkey`);
            
            if (window.presetManager) {
                presetManager.showSwitchNotification({
                    message: `Microphone ${status}`,
                    type: 'audio'
                });
            }
            
            devLog(`🎤 Microphone ${status} (global hotkey)`);
            return true;
        } else {
            console.warn('⚠️ Mute manager not available');
            return false;
        }
    }

    toggleUniversalMute() {
        console.log('🎮 toggleUniversalMute called (could be from global hotkey)');
        
        if (!this.isLiveInterviewActive()) {
            console.warn('⚠️ Universal mute only available during live interview');
            if (window.presetManager) {
                presetManager.showErrorNotification('Start the interview first before using audio controls');
            } else {
                alert('Please start the interview before using audio controls');
            }
            return false;
        }
        
        if (window.muteManager) {
            const currentStatus = muteManager.getMuteStatus();
            const newUniversalStatus = !currentStatus.universal;
            muteManager.setUniversalMute(newUniversalStatus);
            
            const status = newUniversalStatus ? 'paused' : 'active';
            console.log(`⏸️ System ${status} via global hotkey`);
            
            if (window.presetManager) {
                presetManager.showSwitchNotification({
                    message: `System ${status}`,
                    type: 'audio'
                });
            }
            
            devLog(`⏸️ System ${status} (global hotkey)`);
            return true;
        } else {
            console.warn('⚠️ Mute manager not available');
            return false;
        }
    }

    getSystemStatus() {
        if (this.appState.socket && this.appState.socket.readyState === WebSocket.OPEN) {
            this.appState.socket.send(JSON.stringify({ 
                type: 'get_system_status', 
                payload: {} 
            }));
        }
    }

    // Comprehensive state clearing for interview end
    clearInterviewState() {
        console.log('🧹 Clearing interview state...');
        
        // Reset vision mode completely
        this.appState.visionMode = {
            isActive: false,
            screenshotQueue: [],
            maxScreenshots: 4,
            currentVisionProvider: 'primary',
            lastSwitchTime: 0,
            switchCooldown: 1000
        };

        // Clear preset and system status
        this.appState.currentPreset = null;
        this.appState.systemStatus = null;

        // Reset timers and debouncing
        this.lastVisionToggleTime = 0;
        this.lastScreenshotTime = 0;

        // Clear screenshot service
        if (window.screenshotService) {
            screenshotService.clearQueue();
            screenshotService.showVisionMode(false);
        }

        // Reset mute manager
        if (window.muteManager) {
            muteManager.setMicrophoneMute(false);
            muteManager.setUniversalMute(false);
        }

        // Clear any pending vision analysis
        if (window.visionAnalysisResolver) {
            window.visionAnalysisResolver = null;
        }

        console.log('✅ Interview state cleared successfully');
        return true;
    }

    // Reset to initial state (for complete restart)
    resetToInitialState() {
        console.log('🔄 Resetting to initial state...');
        
        // Clear interview state first
        this.clearInterviewState();

        // Clear socket reference (but don't close it here - let WebSocketHandler handle that)
        this.appState.socket = null;

        // Keep onboarding data and provider selections intact
        // This allows user to restart interview without re-entering data
        
        console.log('✅ Reset to initial state complete');
        return true;
    }
} 