// --- audio_handler.js ---
// This module handles all interactions with the Web Media APIs
// for capturing and processing audio via an AudioWorklet.

import { devLog, devError } from './config.js';
import muteManager from './mute-manager.js';

// Must match sample_rate in the Deepgram LiveOptions in services/stt_service.py.
const TARGET_SAMPLE_RATE = 48000;

let audioContext = null;
let micStream = null;
let systemStream = null;
let micGainNode = null;
let screenVideoTrack = null; // Store video track for screenshot reuse

/**
 * Requests permission to use the microphone and populates the dropdown.
 * @returns {Promise<{success: boolean, reason?: string, error?: any}>} Status object detailing microphone availability.
 */
export async function setupMicrophone() {
    const micSelect = document.getElementById('mic-select');
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (micSelect) {
                micSelect.innerHTML = '<option value="">Microphone Not Supported (Optional)</option>';
                micSelect.disabled = true;
            }
            return { success: false, reason: 'not_supported' };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioDevices = devices.filter(device => device.kind === 'audioinput');

        if (audioDevices.length === 0) {
            if (micSelect) {
                micSelect.innerHTML = '<option value="">No Microphone Available (Optional)</option>';
                micSelect.disabled = true;
            }
            return { success: false, reason: 'no_devices' };
        }

        if (micSelect) {
            micSelect.innerHTML = '';
            audioDevices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${micSelect.options.length + 1}`;
                micSelect.appendChild(option);
            });
            micSelect.disabled = false;
        }
        return { success: true };
    } catch (err) {
        devError("Error setting up microphone:", err);
        if (micSelect) {
            micSelect.innerHTML = '<option value="">Microphone Disabled / Unavailable (Optional)</option>';
            micSelect.disabled = true;
        }
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            return { success: false, reason: 'permission_denied', error: err };
        }
        return { success: false, reason: 'exception', error: err };
    }
}

/**
 * Starts audio processing by setting up the AudioContext, loading the worklet,
 * and connecting the audio streams. Microphone input is optional.
 * @param {string} micId - The deviceId of the selected microphone (or empty if disabled/unavailable).
 * @param {function} onAudioData - Callback function to handle the processed PCM audio data.
 * @returns {Promise<boolean>} True if processing started successfully.
 */
export async function startAudioProcessing(micId, onAudioData) {
    try {
        // 1. Get Microphone Stream (Optional)
        micStream = null;
        if (micId) {
            try {
                micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } });
            } catch (micErr) {
                devWarn("⚠️ Could not acquire requested microphone stream, attempting fallback:", micErr);
                try {
                    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                } catch (fallbackErr) {
                    devWarn("⚠️ Could not acquire microphone stream:", fallbackErr);
                    micStream = null;
                }
            }
        } else {
            devLog("ℹ️ No microphone selected; proceeding without microphone input.");
        }

        // 2. Get System Display Stream (Required for interviewer audio capture)
        try {
            systemStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } catch (sysErr) {
            console.error("❌ Could not get system display stream:", sysErr);
            stopAudioProcessing();
            return false;
        }

        if (!systemStream) {
            console.error("Could not get system audio stream.");
            stopAudioProcessing();
            return false;
        }

        // 3. Setup AudioContext and Worklet
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        try {
            audioContext = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
        } catch (rateErr) {
            console.warn('⚠️ Could not pin AudioContext sample rate:', rateErr);
            audioContext = new AudioCtx();
        }
        console.log(`🎵 AudioContext: ${audioContext.sampleRate}Hz`);
        if (audioContext.sampleRate !== TARGET_SAMPLE_RATE) {
            console.warn(`⚠️ AudioContext is ${audioContext.sampleRate}Hz but Deepgram expects ${TARGET_SAMPLE_RATE}Hz - transcription accuracy may suffer`);
        }
        await audioContext.audioWorklet.addModule('/static/js/audio_processor.js');
        
        // 4. Create a single mixed processor
        const mixedProcessor = new AudioWorkletNode(audioContext, 'mixed-processor');

        let audioProcessingCounter = 0;
        
        mixedProcessor.port.onmessage = (event) => {
            if (muteManager.isAudioPaused()) {
                if (audioProcessingCounter % 200 === 0) {
                    devLog(`⏸️ Audio processing paused due to universal mute.`);
                }
                audioProcessingCounter++;
                return;
            }

            const { audioData, micLevel, systemLevel } = event.data;
            let speakerHint;

            if (!micStream || muteManager.isMicrophoneMuted()) {
                speakerHint = 'system';
            } else {
                speakerHint = systemLevel > micLevel * 2 ? 'system' : 'microphone';
            }

            audioProcessingCounter++;
            onAudioData(audioData, speakerHint);
        };

        // 5. Connect available sources
        if (micStream) {
            const micSource = audioContext.createMediaStreamSource(micStream);
            micGainNode = audioContext.createGain();
            updateMicGainNode();
            muteManager.on('microphoneMuteChange', updateMicGainNode);
            micSource.connect(micGainNode);
            micGainNode.connect(mixedProcessor);
        } else {
            micGainNode = null;
        }

        const systemSource = audioContext.createMediaStreamSource(systemStream);
        systemSource.connect(mixedProcessor);

        // Store the video track for screenshot reuse
        const videoTracks = systemStream.getVideoTracks();
        if (videoTracks.length > 0) {
            screenVideoTrack = videoTracks[0];
            console.log("📹 Screen video track stored for screenshot reuse");
        } else {
            console.warn("⚠️ No video track found in display media stream");
        }

        devLog(`✅ Audio processing started successfully (Microphone: ${micStream ? 'Connected' : 'Unavailable/Disabled'})`);
        return true;

    } catch (err) {
        console.error("❌ Error starting audio processing:", err);
        stopAudioProcessing();
        return false;
    }
}

/**
 * Updates the microphone gain node based on the central mute manager state.
 */
function updateMicGainNode() {
    if (!micGainNode || !audioContext) return;
    
    const isMuted = muteManager.isMicrophoneMuted();
    const targetGain = isMuted ? 0 : 1;
    
    // Smooth transition to avoid audio pops
    micGainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.05);
    devLog(`🎤 Microphone gain set to ${targetGain} based on mute manager.`);
}

// --- Legacy Functions (now wrappers for MuteManager) ---
// These are kept for backward compatibility with other modules that might call them.

/**
 * @deprecated Use muteManager.setMicrophoneMute(mute) instead.
 */
export function setMicrophoneMute(mute) {
    muteManager.setMicrophoneMute(mute);
    return muteManager.isMicrophoneMuted();
}

/**
 * @deprecated Use muteManager.isMicrophoneMuted() instead.
 */
export function isMicrophoneMuted() {
    return muteManager.isMicrophoneMuted();
}

/**
 * @deprecated Use muteManager.toggleMicrophoneMute() instead.
 */
export function toggleMicrophoneMute() {
    return muteManager.toggleMicrophoneMute();
}

/**
 * @deprecated Use muteManager.getMuteStatus() instead.
 */
export function getAudioProcessingMode() {
    return muteManager.getMuteStatus();
}

/**
 * Gets the screen video track for screenshot capture.
 * @returns {MediaStreamTrack|null} The screen video track if available.
 */
export function getScreenVideoTrack() {
    return screenVideoTrack;
}

/**
 * Checks if screen sharing is available for screenshots.
 * @returns {boolean} True if screen video track is available and active.
 */
export function isScreenSharingAvailable() {
    return screenVideoTrack && screenVideoTrack.readyState === 'live';
}

/**
 * Stops all audio streams and closes the AudioContext.
 */
export function stopAudioProcessing() {
    console.log("Stopping audio processing.");
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    if (systemStream) {
        systemStream.getTracks().forEach(track => track.stop());
        systemStream = null;
    }
    if (screenVideoTrack) {
        screenVideoTrack.stop();
        screenVideoTrack = null;
        console.log("📹 Screen video track stopped");
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
        audioContext = null;
    }
    
    // Reset mute state in the central manager
    muteManager.setMicrophoneMute(true);
    muteManager.setUniversalMute(false);
    micGainNode = null;
}