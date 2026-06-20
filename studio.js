/**
 * Asset Studio — camera sprite capture & microphone sound recording
 */
(() => {
    const OUTPUT_SIZE = 512;
    const TIER_NAMES = ['Asteroid', 'Moon', 'Planet', 'Star', 'Nebula'];
    const CORNER_PATCH_RATIO = 0.08;

    // DOM refs
    const tabButtons = document.querySelectorAll('.tab-btn');
    const spritesPanel = document.getElementById('sprites-panel');
    const soundsPanel = document.getElementById('sounds-panel');
    const tierSelect = document.getElementById('tier-select');
    const modeDrawingBtn = document.getElementById('mode-drawing');
    const modePhotoBtn = document.getElementById('mode-photo');
    const cameraPreview = document.getElementById('camera-preview');
    const captureBtn = document.getElementById('capture-btn');
    const uploadInput = document.getElementById('upload-input');
    const uploadLabel = document.getElementById('upload-label');
    const cameraError = document.getElementById('camera-error');
    const spriteEdit = document.getElementById('sprite-edit');
    const photoHint = document.getElementById('photo-hint');
    const drawingControls = document.getElementById('drawing-controls');
    const removalSlider = document.getElementById('removal-slider');
    const removalValue = document.getElementById('removal-value');
    const shadowSlider = document.getElementById('shadow-slider');
    const shadowValue = document.getElementById('shadow-value');
    const pickBgBtn = document.getElementById('pick-bg-btn');
    const pickBgHint = document.getElementById('pick-bg-hint');
    const originalPreview = document.getElementById('original-preview');
    const processedPreviewWrap = document.getElementById('processed-preview-wrap');
    const processedPreview = document.getElementById('processed-preview');
    const previewRow = document.querySelector('#sprite-edit .preview-row');
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
    let pickedBackground = null;
    let pickBgMode = false;
    let spriteMode = 'drawing'; // 'drawing' | 'photo'

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

    function analyzePixel(r, g, b) {
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        return { lum, sat, maxC, minC };
    }

    function colorDistance(r, g, b, br, bg, bb) {
        const dr = r - br;
        const dg = g - bg;
        const db = b - bb;
        return Math.sqrt(dr * dr + dg * dg + db * db);
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
    function sampleCornerBackground(imageData) {
        const { data, width, height } = imageData;
        const patchW = Math.max(4, Math.floor(width * CORNER_PATCH_RATIO));
        const patchH = Math.max(4, Math.floor(height * CORNER_PATCH_RATIO));
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;

        const corners = [
            [0, 0],
            [width - patchW, 0],
            [0, height - patchH],
            [width - patchW, height - patchH]
        ];

        corners.forEach(([startX, startY]) => {
            for (let y = startY; y < startY + patchH; y++) {
                for (let x = startX; x < startX + patchW; x++) {
                    const i = (y * width + x) * 4;
                    rSum += data[i];
                    gSum += data[i + 1];
                    bSum += data[i + 2];
                    count++;
                }
            }
        });

        return {
            r: Math.round(rSum / count),
            g: Math.round(gSum / count),
            b: Math.round(bSum / count)
        };
    }

    function buildRemovalOptions(removalStrength, shadowCleanup) {
        const strength = removalStrength / 100;
        const shadow = shadowCleanup / 100;

        return {
            colorTolerance: 12 + strength * 75,
            fuzzyTolerance: 18 + strength * 90,
            lumThreshold: 255 - strength * 135,
            satMax: 0.28 - strength * 0.18,
            shadowLumMin: 255 - shadow * 145,
            shadowSatMax: 0.25 - shadow * 0.1
        };
    }

    function isBackgroundLike(r, g, b, bg, opts, fuzzy) {
        const { lum, sat } = analyzePixel(r, g, b);
        const tolerance = fuzzy ? opts.fuzzyTolerance : opts.colorTolerance;
        const dist = colorDistance(r, g, b, bg.r, bg.g, bg.b);

        if (dist <= tolerance) {
            return true;
        }

        if (sat <= opts.satMax && lum >= opts.lumThreshold) {
            return true;
        }

        return false;
    }

    function removeBackground(imageData, removalStrength, shadowCleanup, customBg) {
        const { data, width, height } = imageData;
        const bg = customBg || sampleCornerBackground(imageData);
        const opts = buildRemovalOptions(removalStrength, shadowCleanup);
        const visited = new Uint8Array(width * height);
        const queue = [];

        function idx(x, y) {
            return y * width + x;
        }

        function enqueue(x, y, fuzzy) {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            const i = idx(x, y);
            if (visited[i]) return;
            const pi = i * 4;
            if (!isBackgroundLike(data[pi], data[pi + 1], data[pi + 2], bg, opts, fuzzy)) {
                return;
            }
            visited[i] = 1;
            queue.push(i);
        }

        for (let x = 0; x < width; x++) {
            enqueue(x, 0, false);
            enqueue(x, height - 1, false);
        }
        for (let y = 0; y < height; y++) {
            enqueue(0, y, false);
            enqueue(width - 1, y, false);
        }

        while (queue.length > 0) {
            const i = queue.pop();
            const x = i % width;
            const y = (i - x) / width;
            enqueue(x - 1, y, true);
            enqueue(x + 1, y, true);
            enqueue(x, y - 1, true);
            enqueue(x, y + 1, true);
        }

        for (let i = 0; i < width * height; i++) {
            const pi = i * 4;
            const r = data[pi];
            const g = data[pi + 1];
            const b = data[pi + 2];

            if (visited[i]) {
                data[pi + 3] = 0;
                continue;
            }

            const { lum, sat } = analyzePixel(r, g, b);
            const isInteriorPaper = isBackgroundLike(r, g, b, bg, opts, false);

            if (isInteriorPaper) {
                const preserve = Math.min(255, Math.round((lum - opts.lumThreshold + 40) * 4));
                data[pi + 3] = Math.min(data[pi + 3], Math.max(48, preserve));
            }
        }

        for (let i = 0; i < width * height; i++) {
            if (visited[i]) continue;

            const pi = i * 4;
            const r = data[pi];
            const g = data[pi + 1];
            const b = data[pi + 2];
            const { lum, sat } = analyzePixel(r, g, b);

            if (data[pi + 3] === 0) continue;

            const nearBg = colorDistance(r, g, b, bg.r, bg.g, bg.b) <= opts.colorTolerance + 10;
            const shadowLike = sat <= opts.shadowSatMax && lum >= opts.shadowLumMin;

            if (nearBg || shadowLike) {
                data[pi + 3] = 0;
            }
        }

        return imageData;
    }

    function processPhotoCanvas(sourceCanvas) {
        const out = document.createElement('canvas');
        out.width = OUTPUT_SIZE;
        out.height = OUTPUT_SIZE;
        const outCtx = out.getContext('2d');
        outCtx.drawImage(sourceCanvas, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
        return out;
    }

    function isPhotoMode() {
        return spriteMode === 'photo';
    }

    function getCameraFacingMode() {
        return isPhotoMode() ? 'user' : 'environment';
    }

    function updateUploadCapture() {
        if (isPhotoMode()) {
            uploadInput.setAttribute('capture', 'user');
        } else {
            uploadInput.setAttribute('capture', 'environment');
        }
    }

    function setSpriteMode(mode) {
        spriteMode = mode;
        const isPhoto = mode === 'photo';

        modeDrawingBtn.classList.toggle('active', !isPhoto);
        modePhotoBtn.classList.toggle('active', isPhoto);
        modeDrawingBtn.setAttribute('aria-pressed', isPhoto ? 'false' : 'true');
        modePhotoBtn.setAttribute('aria-pressed', isPhoto ? 'true' : 'false');

        captureBtn.textContent = isPhoto ? 'Take Selfie' : 'Take Photo';
        uploadLabel.textContent = isPhoto ? 'Upload Selfie' : 'Upload Photo';

        drawingControls.classList.toggle('hidden', isPhoto);
        photoHint.classList.toggle('hidden', !isPhoto);
        processedPreviewWrap.classList.toggle('hidden', isPhoto);
        previewRow.classList.toggle('preview-row-three', !isPhoto);
        previewRow.classList.toggle('preview-row-two', isPhoto);

        originalPreview.classList.toggle('pick-target', !isPhoto);
        cameraPreview.classList.toggle('mirror', isPhoto);

        updateUploadCapture();

        if (pickBgMode && isPhoto) {
            setPickBgMode(false);
        }

        pickedBackground = null;

        if (rawCaptureCanvas) {
            updateProcessedPreview();
        } else if (spritesPanel.classList.contains('active')) {
            startCamera();
        }
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

    function processSpriteCanvas(sourceCanvas, removalStrength, shadowCleanup, customBg) {
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        const imageData = ctx.getImageData(0, 0, w, h);

        removeBackground(imageData, removalStrength, shadowCleanup, customBg);
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

    function drawOriginalPreview() {
        if (!rawCaptureCanvas) return;
        const ctx = originalPreview.getContext('2d');
        ctx.clearRect(0, 0, originalPreview.width, originalPreview.height);
        ctx.drawImage(rawCaptureCanvas, 0, 0, originalPreview.width, originalPreview.height);
    }

    function drawPreviews(processedCanvas) {
        drawOriginalPreview();

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

        let processed;

        if (isPhotoMode()) {
            processed = processPhotoCanvas(rawCaptureCanvas);
        } else {
            const removalStrength = Number(removalSlider.value);
            const shadowCleanup = Number(shadowSlider.value);
            removalValue.textContent = String(removalStrength);
            shadowValue.textContent = String(shadowCleanup);

            processed = processSpriteCanvas(
                rawCaptureCanvas,
                removalStrength,
                shadowCleanup,
                pickedBackground
            );
        }

        drawPreviews(processed);

        processed.toBlob((blob) => {
            processedBlob = blob;
        }, 'image/png');
    }

    function setPickBgMode(active) {
        if (isPhotoMode()) {
            active = false;
        }
        pickBgMode = active;
        pickBgBtn.classList.toggle('active', active);
        originalPreview.classList.toggle('pick-mode', active);
        pickBgHint.textContent = active
            ? 'Tap the original photo on an empty area of paper'
            : pickedBackground
                ? `Paper color: rgb(${pickedBackground.r}, ${pickedBackground.g}, ${pickedBackground.b}) — tap Pick to change`
                : 'Auto-detects paper from corners — or tap Pick to sample manually';
    }

    function sampleBackgroundFromPreview(clientX, clientY) {
        if (!rawCaptureCanvas || isPhotoMode()) return;

        const rect = originalPreview.getBoundingClientRect();
        const x = Math.floor(((clientX - rect.left) / rect.width) * rawCaptureCanvas.width);
        const y = Math.floor(((clientY - rect.top) / rect.height) * rawCaptureCanvas.height);
        const ctx = rawCaptureCanvas.getContext('2d', { willReadFrequently: true });
        const pixel = ctx.getImageData(x, y, 1, 1).data;

        pickedBackground = { r: pixel[0], g: pixel[1], b: pixel[2] };
        setPickBgMode(false);
        updateProcessedPreview();
        showToast(`Paper color sampled — rgb(${pickedBackground.r}, ${pickedBackground.g}, ${pickedBackground.b})`);
    }

    function loadImageToCanvas(source) {
        const img = new Image();
        img.onload = () => {
            const size = Math.min(img.width, img.height);
            const sx = (img.width - size) / 2;
            const sy = (img.height - size) / 2;

            rawCaptureCanvas = document.createElement('canvas');
            rawCaptureCanvas.width = size;
            rawCaptureCanvas.height = size;
            const ctx = rawCaptureCanvas.getContext('2d');
            ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size);

            pickedBackground = null;
            spriteEdit.classList.remove('hidden');
            captureBtn.classList.add('hidden');
            setPickBgMode(false);
            updateProcessedPreview();
        };
        img.onerror = () => showToast('Could not load that image.');
        img.src = source;
    }

    function enterEditMode() {
        spriteEdit.classList.remove('hidden');
        captureBtn.classList.add('hidden');
        setPickBgMode(false);
        updateProcessedPreview();
    }

    // ---------------------------------------------------------
    // Camera
    // ---------------------------------------------------------
    async function startCamera() {
        hideError(cameraError);

        if (!isSecureContext()) {
            showError(
                cameraError,
                'Live camera requires HTTPS (e.g. GitHub Pages). You can still use Upload Photo, or open via https://.'
            );
            captureBtn.disabled = true;
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showError(cameraError, 'Camera is not supported in this browser. Use Upload Photo instead.');
            captureBtn.disabled = true;
            return;
        }

        try {
            stopCamera();
            const facingMode = getCameraFacingMode();
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: facingMode },
                    width: { ideal: 1280 },
                    height: { ideal: 1280 }
                },
                audio: false
            });
            cameraPreview.srcObject = cameraStream;
            captureBtn.disabled = false;
        } catch (err) {
            showError(cameraError, `Camera unavailable: ${err.message}. Try Upload Photo instead.`);
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

        if (isPhotoMode()) {
            ctx.translate(size, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(cameraPreview, sx, sy, size, size, 0, 0, size, size);

        pickedBackground = null;
        enterEditMode();
    }

    function retakePhoto() {
        rawCaptureCanvas = null;
        processedBlob = null;
        pickedBackground = null;
        pickBgMode = false;
        spriteEdit.classList.add('hidden');
        captureBtn.classList.remove('hidden');
        uploadInput.value = '';
        setPickBgMode(false);
    }

    function handleUpload(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => loadImageToCanvas(reader.result);
        reader.onerror = () => showToast('Could not read that file.');
        reader.readAsDataURL(file);
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
            showError(micError, 'Microphone requires HTTPS (e.g. GitHub Pages).');
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
    uploadInput.addEventListener('change', handleUpload);
    retakeBtn.addEventListener('click', retakePhoto);
    removalSlider.addEventListener('input', updateProcessedPreview);
    shadowSlider.addEventListener('input', updateProcessedPreview);
    saveSpriteBtn.addEventListener('click', saveSprite);
    resetSpriteBtn.addEventListener('click', resetSprite);

    modeDrawingBtn.addEventListener('click', () => setSpriteMode('drawing'));
    modePhotoBtn.addEventListener('click', () => setSpriteMode('photo'));

    pickBgBtn.addEventListener('click', () => {
        if (!rawCaptureCanvas || isPhotoMode()) return;
        setPickBgMode(!pickBgMode);
    });

    function handleOriginalPreviewPick(event) {
        if (!pickBgMode || isPhotoMode()) return;
        event.preventDefault();
        const point = event.touches ? event.touches[0] : event;
        sampleBackgroundFromPreview(point.clientX, point.clientY);
    }

    originalPreview.addEventListener('click', handleOriginalPreviewPick);
    originalPreview.addEventListener('touchstart', handleOriginalPreviewPick, { passive: false });

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

    setPickBgMode(false);
    setSpriteMode('drawing');
    startCamera();
})();
