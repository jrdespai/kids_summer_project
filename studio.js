/**
 * Asset Studio — camera sprite capture & microphone sound recording
 */
(() => {
    const OUTPUT_SIZE = 512;
    const TIER_NAMES = ['Asteroid', 'Moon', 'Planet', 'Star', 'Nebula'];

    // DOM refs
    const tabButtons = document.querySelectorAll('.tab-btn');
    const spritesPanel = document.getElementById('sprites-panel');
    const soundsPanel = document.getElementById('sounds-panel');
    const tierSelect = document.getElementById('tier-select');
    const cameraPreview = document.getElementById('camera-preview');
    const captureCanvas = document.getElementById('capture-canvas');
    const captureBtn = document.getElementById('capture-btn');
    const cameraError = document.getElementById('camera-error');
    const spriteEdit = document.getElementById('sprite-edit');
    const thresholdSlider = document.getElementById('threshold-slider');
    const thresholdValue = document.getElementById('threshold-value');
    const processedPreview = document.getElementById('processed-preview');
    const circlePreview = document.getElementById('circle-preview');
    const saveSpriteBtn = document.getElementById('save-sprite-btn');
    const retakeBtn = document.getElementById('retake-btn');
    const resetSpriteBtn = document.getElementById('reset-sprite-btn');

    const soundSelect = document.getElementById('sound-select');
    const micError = document.getElementById('mic-error');
    const recordBtn = document.getElementById('record-btn');
    const stopRecordBtn = document.getElementById('stop-record-btn');
    const playRecordBtn = document.getElementById('play-record-btn');
    const saveSoundBtn = document.getElementById('save-sound-btn');
    const resetSoundBtn = document.getElementById('reset-sound-btn');
    const recorderIndicator = document.getElementById('recorder-indicator');
    const recorderLabel = document.getElementById('recorder-label');
    const toastEl = document.getElementById('toast');

    let cameraStream = null;
    let rawCaptureCanvas = null;
    let processedBlob = null;
    let toastTimer = null;

    let mediaRecorder = null;
    let micStream = null;
    let recordedChunks = [];
    let recordedBlob = null;
    let previewAudio = null;

    // ---------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------
    function showToast(message) {
        toastEl.textContent = message;
        toastEl.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
    }

    function isSecureContext() {
        return window.isSecureContext;
    }

    function showError(el, message) {
        el.textContent = message;
        el.classList.remove('hidden');
    }

    function hideError(el) {
        el.classList.add('hidden');
        el.textContent = '';
    }

    // ---------------------------------------------------------
    // Tabs
    // ---------------------------------------------------------
    tabButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            tabButtons.forEach((b) => {
                const active = b === btn;
                b.classList.toggle('active', active);
                b.setAttribute('aria-selected', active ? 'true' : 'false');
            });

            const showSprites = tab === 'sprites';
            spritesPanel.classList.toggle('active', showSprites);
            spritesPanel.hidden = !showSprites;
            soundsPanel.classList.toggle('active', !showSprites);
            soundsPanel.hidden = showSprites;

            if (showSprites) {
                startCamera();
            } else {
                stopCamera();
            }
        });
    });

    // ---------------------------------------------------------
    // Sprite processing
    // ---------------------------------------------------------
    function removeWhiteBackground(imageData, threshold) {
        const { data, width, height } = imageData;
        const visited = new Uint8Array(width * height);
        const queue = [];

        function idx(x, y) {
            return y * width + x;
        }

        function isPaperLike(i) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            return r >= threshold && g >= threshold && b >= threshold;
        }

        function enqueue(x, y) {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            const i = idx(x, y);
            if (visited[i]) return;
            const pi = i * 4;
            if (!isPaperLike(pi)) return;
            visited[i] = 1;
            queue.push(i);
        }

        for (let x = 0; x < width; x++) {
            enqueue(x, 0);
            enqueue(x, height - 1);
        }
        for (let y = 0; y < height; y++) {
            enqueue(0, y);
            enqueue(width - 1, y);
        }

        while (queue.length > 0) {
            const i = queue.pop();
            const x = i % width;
            const y = (i - x) / width;
            enqueue(x - 1, y);
            enqueue(x + 1, y);
            enqueue(x, y - 1);
            enqueue(x, y + 1);
        }

        for (let i = 0; i < width * height; i++) {
            const pi = i * 4;
            if (visited[i]) {
                data[pi + 3] = 0;
            } else if (isPaperLike(pi)) {
                const r = data[pi];
                const g = data[pi + 1];
                const b = data[pi + 2];
                const minChannel = Math.min(r, g, b);
                const feather = Math.max(0, minChannel - (threshold - 25));
                data[pi + 3] = Math.min(data[pi + 3], Math.round(255 - feather * 10));
            }
        }

        return imageData;
    }

    function findContentBounds(imageData) {
        const { data, width, height } = imageData;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        let found = false;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const alpha = data[(y * width + x) * 4 + 3];
                if (alpha > 16) {
                    found = true;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (!found) return null;
        return { minX, minY, maxX, maxY };
    }

    function processSpriteCanvas(sourceCanvas, threshold) {
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        let imageData = ctx.getImageData(0, 0, w, h);

        imageData = removeWhiteBackground(imageData, threshold);
        const bounds = findContentBounds(imageData);

        const out = document.createElement('canvas');
        out.width = OUTPUT_SIZE;
        out.height = OUTPUT_SIZE;
        const outCtx = out.getContext('2d');

        if (!bounds) {
            return out;
        }

        const cropW = bounds.maxX - bounds.minX + 1;
        const cropH = bounds.maxY - bounds.minY + 1;
        const temp = document.createElement('canvas');
        temp.width = cropW;
        temp.height = cropH;
        const tempCtx = temp.getContext('2d');
        tempCtx.putImageData(imageData, -bounds.minX, -bounds.minY);

        const scale = Math.min(OUTPUT_SIZE / cropW, OUTPUT_SIZE / cropH) * 0.92;
        const drawW = cropW * scale;
        const drawH = cropH * scale;
        const dx = (OUTPUT_SIZE - drawW) / 2;
        const dy = (OUTPUT_SIZE - drawH) / 2;

        outCtx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
        outCtx.drawImage(temp, dx, dy, drawW, drawH);

        return out;
    }

    function drawPreviews(processedCanvas) {
        const pCtx = processedPreview.getContext('2d');
        pCtx.clearRect(0, 0, processedPreview.width, processedPreview.height);
        pCtx.drawImage(processedCanvas, 0, 0, processedPreview.width, processedPreview.height);

        const cCtx = circlePreview.getContext('2d');
        const size = circlePreview.width;
        cCtx.clearRect(0, 0, size, size);
        cCtx.save();
        cCtx.beginPath();
        cCtx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
        cCtx.clip();
        cCtx.drawImage(processedCanvas, 0, 0, size, size);
        cCtx.restore();
        cCtx.strokeStyle = 'rgba(203, 213, 225, 0.8)';
        cCtx.lineWidth = 2;
        cCtx.beginPath();
        cCtx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
        cCtx.stroke();
    }

    function updateProcessedPreview() {
        if (!rawCaptureCanvas) return;
        const threshold = Number(thresholdSlider.value);
        thresholdValue.textContent = String(threshold);
        const processed = processSpriteCanvas(rawCaptureCanvas, threshold);
        drawPreviews(processed);

        processed.toBlob((blob) => {
            processedBlob = blob;
        }, 'image/png');
    }

    // ---------------------------------------------------------
    // Camera
    // ---------------------------------------------------------
    async function startCamera() {
        hideError(cameraError);

        if (!isSecureContext()) {
            showError(cameraError, 'Camera requires a secure connection. Run npm start and open http://localhost:3000/studio.html (not file://).');
            captureBtn.disabled = true;
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showError(cameraError, 'Camera is not supported in this browser.');
            captureBtn.disabled = true;
            return;
        }

        try {
            stopCamera();
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 1280 }
                },
                audio: false
            });
            cameraPreview.srcObject = cameraStream;
            captureBtn.disabled = false;
        } catch (err) {
            showError(cameraError, `Camera access denied or unavailable: ${err.message}`);
            captureBtn.disabled = true;
        }
    }

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach((t) => t.stop());
            cameraStream = null;
        }
        cameraPreview.srcObject = null;
    }

    function capturePhoto() {
        if (!cameraStream) return;

        const videoW = cameraPreview.videoWidth;
        const videoH = cameraPreview.videoHeight;
        if (!videoW || !videoH) return;

        const size = Math.min(videoW, videoH);
        const sx = (videoW - size) / 2;
        const sy = (videoH - size) / 2;

        rawCaptureCanvas = document.createElement('canvas');
        rawCaptureCanvas.width = size;
        rawCaptureCanvas.height = size;
        const ctx = rawCaptureCanvas.getContext('2d');
        ctx.drawImage(cameraPreview, sx, sy, size, size, 0, 0, size, size);

        spriteEdit.classList.remove('hidden');
        captureBtn.classList.add('hidden');
        updateProcessedPreview();
    }

    function retakePhoto() {
        rawCaptureCanvas = null;
        processedBlob = null;
        spriteEdit.classList.add('hidden');
        captureBtn.classList.remove('hidden');
    }

    // ---------------------------------------------------------
    // Sound recording
    // ---------------------------------------------------------
    function getRecorderMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/aac'
        ];
        return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    }

    async function startRecording() {
        hideError(micError);

        if (!isSecureContext()) {
            showError(micError, 'Microphone requires a secure connection. Run npm start and open via localhost.');
            return;
        }

        try {
            if (micStream) {
                micStream.getTracks().forEach((t) => t.stop());
            }

            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recordedChunks = [];
            recordedBlob = null;
            saveSoundBtn.disabled = true;
            playRecordBtn.disabled = true;

            const mimeType = getRecorderMimeType();
            mediaRecorder = mimeType
                ? new MediaRecorder(micStream, { mimeType })
                : new MediaRecorder(micStream);

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                const type = mediaRecorder.mimeType || 'audio/webm';
                recordedBlob = new Blob(recordedChunks, { type });
                playRecordBtn.disabled = false;
                saveSoundBtn.disabled = false;
                recorderIndicator.classList.remove('recording');
                recorderLabel.textContent = 'Recording ready — preview or save';
                recordBtn.disabled = false;
                stopRecordBtn.disabled = true;
            };

            mediaRecorder.start();
            recorderIndicator.classList.add('recording');
            recorderLabel.textContent = 'Recording…';
            recordBtn.disabled = true;
            stopRecordBtn.disabled = false;
        } catch (err) {
            showError(micError, `Microphone access denied or unavailable: ${err.message}`);
        }
    }

    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
        if (micStream) {
            micStream.getTracks().forEach((t) => t.stop());
            micStream = null;
        }
    }

    function playRecording() {
        if (!recordedBlob) return;
        if (previewAudio) {
            previewAudio.pause();
            previewAudio = null;
        }
        previewAudio = new Audio(AssetStore.createObjectUrl(recordedBlob));
        previewAudio.play().catch(() => {
            showToast('Could not play preview — tap again.');
        });
        previewAudio.onended = () => {
            AssetStore.revokeObjectUrl(previewAudio.src);
            previewAudio = null;
        };
    }

    // ---------------------------------------------------------
    // Save / reset
    // ---------------------------------------------------------
    async function saveSprite() {
        if (!processedBlob) {
            showToast('Capture a photo first.');
            return;
        }

        const tier = Number(tierSelect.value);
        try {
            await AssetStore.putSprite(tier, processedBlob);
            showToast(`Saved ${TIER_NAMES[tier]} sprite — open the game to see it.`);
            retakePhoto();
        } catch (err) {
            showToast(`Save failed: ${err.message}`);
        }
    }

    async function resetSprite() {
        const tier = Number(tierSelect.value);
        try {
            await AssetStore.deleteSprite(tier);
            showToast(`${TIER_NAMES[tier]} reset to default. Reload the game.`);
        } catch (err) {
            showToast(`Reset failed: ${err.message}`);
        }
    }

    async function saveSound() {
        if (!recordedBlob) {
            showToast('Record a sound first.');
            return;
        }

        const name = soundSelect.value;
        try {
            await AssetStore.putSound(name, recordedBlob);
            showToast(`Saved "${name}" sound — open the game to hear it.`);
            recordedBlob = null;
            recordedChunks = [];
            playRecordBtn.disabled = true;
            saveSoundBtn.disabled = true;
            recorderLabel.textContent = 'Ready to record';
        } catch (err) {
            showToast(`Save failed: ${err.message}`);
        }
    }

    async function resetSound() {
        const name = soundSelect.value;
        try {
            await AssetStore.deleteSound(name);
            showToast(`"${name}" reset to default. Reload the game.`);
        } catch (err) {
            showToast(`Reset failed: ${err.message}`);
        }
    }

    // ---------------------------------------------------------
    // Event bindings
    // ---------------------------------------------------------
    captureBtn.addEventListener('click', capturePhoto);
    retakeBtn.addEventListener('click', retakePhoto);
    thresholdSlider.addEventListener('input', updateProcessedPreview);
    saveSpriteBtn.addEventListener('click', saveSprite);
    resetSpriteBtn.addEventListener('click', resetSprite);

    recordBtn.addEventListener('click', startRecording);
    stopRecordBtn.addEventListener('click', stopRecording);
    playRecordBtn.addEventListener('click', playRecording);
    saveSoundBtn.addEventListener('click', saveSound);
    resetSoundBtn.addEventListener('click', resetSound);

    window.addEventListener('beforeunload', () => {
        stopCamera();
        stopRecording();
        AssetStore.revokeAllObjectUrls();
    });

    // Boot camera on load (sprites tab is default)
    startCamera();
})();
