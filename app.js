/**
 * Antigravity Physics Lab
 * Core Application Logic - Mobile & Tablet Optimized Canvas Physics
 * Uses Matter.js via CDN
 */

// Self-executing setup module to avoid global scope pollution
(() => {
    // ---------------------------------------------------------
    // 0. Asset Configuration & Mapping
    // ---------------------------------------------------------
    const DEFAULT_SPRITE_CONFIG = {
        0: 'assets/images/tier1.png', // Asteroid
        1: 'assets/images/tier2.png', // Moon
        2: 'assets/images/tier3.png', // Planet
        3: 'assets/images/tier4.png', // Star
        4: 'assets/images/tier5.png'  // Nebula
    };

    const DEFAULT_SOUND_CONFIG = {
        spawn: 'assets/sounds/spawn.mp3',
        merge: 'assets/sounds/merge.mp3',
        gameover: 'assets/sounds/gameover.mp3'
    };

    const spriteConfig = { ...DEFAULT_SPRITE_CONFIG };
    const soundConfig = { ...DEFAULT_SOUND_CONFIG };

    async function resolveAssetUrls() {
        if (!window.AssetStore) return;

        AssetStore.revokeAllObjectUrls();
        Object.assign(spriteConfig, DEFAULT_SPRITE_CONFIG);
        Object.assign(soundConfig, DEFAULT_SOUND_CONFIG);

        try {
            const overrides = await AssetStore.getAllOverrides();
            overrides.sprites.forEach(({ tier, blob }) => {
                spriteConfig[tier] = AssetStore.createObjectUrl(blob);
            });
            overrides.sounds.forEach(({ name, blob }) => {
                soundConfig[name] = AssetStore.createObjectUrl(blob);
            });
        } catch (err) {
            console.warn('Could not load custom assets from IndexedDB:', err);
        }
    }

    // ---------------------------------------------------------
    // 0.5 Web Audio Manager for Overlapping, Lag-Free Sound Playback
    // ---------------------------------------------------------
    class WebAudioManager {
        constructor(soundConfig) {
            this.config = soundConfig;
            this.ctx = null;
            this.buffers = {};
            this.pendingPlays = new Set();
            this.initialized = false;
        }

        init() {
            if (this.initialized) return;
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) {
                console.warn('Web Audio API is not supported in this browser. Sound effects disabled.');
                return;
            }
            this.ctx = new AudioContextClass();
            this.initialized = true;

            Object.entries(this.config).forEach(([name, path]) => {
                this.loadSound(name, path);
            });
        }

        onBufferReady(name) {
            if (this.pendingPlays.has(name)) {
                this.pendingPlays.delete(name);
                this.play(name);
            }
        }

        async loadSound(name, path) {
            try {
                const response = await fetch(path);
                if (!response.ok) {
                    throw new Error(`Failed to fetch sound file (status ${response.status})`);
                }
                const arrayBuffer = await response.arrayBuffer();

                // Safari and older iOS compatibility for decodeAudioData
                if (this.ctx.decodeAudioData.length === 2) {
                    this.ctx.decodeAudioData(arrayBuffer, (buffer) => {
                        this.buffers[name] = buffer;
                        this.onBufferReady(name);
                    }, (err) => {
                        console.warn(`Error decoding audio "${name}":`, err);
                    });
                } else {
                    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
                    this.buffers[name] = buffer;
                    this.onBufferReady(name);
                }
            } catch (error) {
                console.warn(`Audio Manager: Sound file "${name}" could not be loaded from ${path}. Error: ${error.message}`);
            }
        }

        resume() {
            if (this.ctx && this.ctx.state === 'suspended') {
                return this.ctx.resume().catch((err) => {
                    console.warn('Could not resume audio context:', err);
                });
            }
            return Promise.resolve();
        }

        startPlayback(name) {
            const buffer = this.buffers[name];
            if (!buffer || !this.ctx) {
                this.pendingPlays.add(name);
                return;
            }

            const source = this.ctx.createBufferSource();
            source.buffer = buffer;

            const gainNode = this.ctx.createGain();
            const volume = name === 'gameover' ? 0.75 : 0.4;
            gainNode.gain.setValueAtTime(volume, this.ctx.currentTime);

            source.connect(gainNode);
            gainNode.connect(this.ctx.destination);
            source.start(0);
        }

        play(name) {
            if (!this.initialized) {
                this.init();
            }
            if (!this.ctx) return;

            // Wait for context resume — game over fires without a tap, so this must complete first
            this.resume().then(() => this.startPlayback(name));
        }

        reloadSounds() {
            this.buffers = {};
            this.pendingPlays.clear();
            if (!this.initialized) return;
            Object.entries(this.config).forEach(([name, path]) => {
                this.loadSound(name, path);
            });
        }
    }

    const audioManager = new WebAudioManager(soundConfig);

    // ---------------------------------------------------------
    // 0.6 Sprite Texture Preloader
    // ---------------------------------------------------------
    const spriteImages = {};

    function preloadSprites() {
        Object.keys(spriteImages).forEach((tier) => delete spriteImages[tier]);
        Object.entries(spriteConfig).forEach(([tier, src]) => {
            const img = new Image();
            img.src = src;
            img.onload = () => {
                spriteImages[tier] = img;
            };
            img.onerror = () => {
                console.warn(`Sprite Preloader: Failed to load texture for tier ${tier} from ${src}. Falling back to vector rendering.`);
                spriteImages[tier] = null;
            };
        });
    }

    async function reloadCustomAssets() {
        await resolveAssetUrls();
        preloadSprites();
        audioManager.reloadSounds();
    }

    // ---------------------------------------------------------
    // 1. Matter.js Module Aliases
    // ---------------------------------------------------------
    const { Engine, Render, Runner, Bodies, Composite, World, Sleeping } = Matter;

    // ---------------------------------------------------------
    // 2. Application State & Configuration
    // ---------------------------------------------------------
    const container = document.getElementById('canvas-container');
    const controlBar = document.getElementById('control-bar');
    const shapeCounterEl = document.getElementById('shape-counter');
    const scoreCounterEl = document.getElementById('score-counter');
    const resetBtn = document.getElementById('reset-btn');
    const gravityToggleBtn = document.getElementById('gravity-toggle-btn');
    const instructionEl = document.getElementById('tap-instruction');
    
    // Danger Warning & Game Over elements
    const dangerWarningEl = document.getElementById('danger-warning');
    const gameOverOverlayEl = document.getElementById('game-over-overlay');
    const finalScoreValueEl = document.getElementById('final-score-value');
    const bestScoreValueEl = document.getElementById('best-score-value');
    const bestScoreCounterEl = document.getElementById('best-score-counter');
    const newBestBannerEl = document.getElementById('new-best-banner');
    const expertModeBtn = document.getElementById('expert-mode-btn');
    const milestoneToastEl = document.getElementById('milestone-toast');
    const milestoneTitleEl = document.getElementById('milestone-title');
    const milestoneSubtitleEl = document.getElementById('milestone-subtitle');
    const dailyChallengeEl = document.getElementById('daily-challenge');
    const dailyChallengeTextEl = document.getElementById('daily-challenge-text');
    const dailyChallengeProgressEl = document.getElementById('daily-challenge-progress');
    const restartBtn = document.getElementById('restart-btn');

    let engine;
    let render;
    let runner;
    let boundaries = []; // References to static wall bodies
    let hasInteracted = false; // Flag to hide instruction overlay

    // Game state variables
    let score = 0;
    let currentDropTier = null; // index (0-2) of currently active drop shape
    let nextDropTier = null;    // index (0-2) of next drop shape
    let previewX = 0;           // lerped X position of preview circle
    let targetX = 0;            // target X position from user interaction
    let canDrop = true;         // drop cooldown flag
    let isPointerDown = false;  // tracking pointer down state
    let isGravityReversed = false;
    let particles = [];         // active particle system particles
    const LAUNCH_Y = 50;        // Y coordinate of the Drop Launch Zone
    const NORMAL_GRAVITY_Y = 1;
    const REVERSED_GRAVITY_Y = -1;
    
    // Game Over state variables
    let isGameOver = false;
    let aboveLineTime = 0;

    // Game modes, combos, and persistent stats
    const GAME_MODES = {
        classic: { dropCooldown: 500, breachLimit: 3000, maxDropTier: 3, showTierNames: false },
        expert: { dropCooldown: 250, breachLimit: 2000, maxDropTier: 4, showTierNames: true }
    };
    const COMBO_WINDOW_MS = 1500;
    const SCORE_MILESTONES = [500, 1000, 5000];
    let isExpertMode = false;
    let gameStats = {
        classicBest: 0,
        expertBest: 0,
        totalGames: 0,
        expertMode: false,
        bestTierReached: 0,
        milestones: { first_star: false, first_nebula: false },
        dailyChallenges: {}
    };
    let lastMergeTime = 0;
    let comboCount = 0;
    let comboPopups = [];
    let runCrossedScoreMilestones = new Set();
    let maxTierThisRun = 0;
    let milestoneToastTimer = null;
    let todaysChallenge = null;
    let runChallengeState = {
        drops: 0,
        merges: 0,
        maxCombo: 1,
        gravityReversed: false
    };

    const DAILY_CHALLENGE_POOL = [
        {
            id: 'reach_star',
            title: 'Reach a Star',
            progress(run) {
                if (run.maxTier >= 3) return 'Complete!';
                const names = ['Asteroid', 'Moon', 'Planet', 'Star'];
                return `Highest: ${names[run.maxTier]}`;
            },
            check(run) { return run.maxTier >= 3; }
        },
        {
            id: 'reach_nebula',
            title: 'Create a Nebula',
            progress(run) {
                if (run.maxTier >= 4) return 'Complete!';
                const names = ['Asteroid', 'Moon', 'Planet', 'Star', 'Nebula'];
                return `Highest: ${names[run.maxTier]}`;
            },
            check(run) { return run.maxTier >= 4; }
        },
        {
            id: 'score_500',
            title: 'Score 500 points',
            progress(run) { return `${Math.min(run.score, 500)}/500`; },
            check(run) { return run.score >= 500; }
        },
        {
            id: 'score_300',
            title: 'Score 300 points',
            progress(run) { return `${Math.min(run.score, 300)}/300`; },
            check(run) { return run.score >= 300; }
        },
        {
            id: 'score_800_40drops',
            title: 'Score 800 in 40 drops or less',
            progress(run) { return `${run.score}/800 · ${run.drops}/40 drops`; },
            check(run) { return run.score >= 800 && run.drops <= 40; }
        },
        {
            id: 'score_400_30drops',
            title: 'Score 400 in 30 drops or less',
            progress(run) { return `${run.score}/400 · ${run.drops}/30 drops`; },
            check(run) { return run.score >= 400 && run.drops <= 30; }
        },
        {
            id: 'merges_8',
            title: 'Merge 8 times in one run',
            progress(run) { return `${Math.min(run.merges, 8)}/8 merges`; },
            check(run) { return run.merges >= 8; }
        },
        {
            id: 'merges_15',
            title: 'Merge 15 times in one run',
            progress(run) { return `${Math.min(run.merges, 15)}/15 merges`; },
            check(run) { return run.merges >= 15; }
        },
        {
            id: 'combo_3',
            title: 'Hit a 3x combo',
            progress(run) { return run.maxCombo >= 3 ? 'Complete!' : `Best combo: ${run.maxCombo}x`; },
            check(run) { return run.maxCombo >= 3; }
        },
        {
            id: 'combo_2',
            title: 'Hit a 2x combo',
            progress(run) { return run.maxCombo >= 2 ? 'Complete!' : 'Chain 2 merges quickly'; },
            check(run) { return run.maxCombo >= 2; }
        },
        {
            id: 'planet_20drops',
            title: 'Reach Planet tier in 20 drops',
            progress(run) { return `${run.drops}/20 drops · tier ${run.maxTier}/2`; },
            check(run) { return run.maxTier >= 2 && run.drops <= 20; }
        },
        {
            id: 'gravity_200',
            title: 'Score 200 with gravity reversed',
            progress(run) {
                if (!run.gravityReversed) return `${run.score}/200 · flip gravity!`;
                return `${Math.min(run.score, 200)}/200`;
            },
            check(run) { return run.gravityReversed && run.score >= 200; }
        }
    ];

    // Authoritative tier lookup — survives Matter body property edge cases
    const bodyTierById = new Map();
    let mergedPairsThisStep = new Set();

    // 5 Distinct Celestial Tiers
    const CELESTIAL_TIERS = [
        { tier: 0, name: 'Asteroid', radius: 16, color: '#8e9196', darkColor: '#374151', stroke: '#cbd5e1', label: '🪨', score: 2 },
        { tier: 1, name: 'Moon', radius: 26, color: '#00f2fe', darkColor: '#0369a1', stroke: '#e0f2fe', label: '🌙', score: 4 },
        { tier: 2, name: 'Planet', radius: 42, color: '#adff2f', darkColor: '#3f6212', stroke: '#f0fdf4', label: '🪐', score: 8 },
        { tier: 3, name: 'Star', radius: 64, color: '#ffd60a', darkColor: '#a16207', stroke: '#fef9c3', label: '⭐', score: 16 },
        { tier: 4, name: 'Nebula', radius: 90, color: '#bf5af2', darkColor: '#6b21a8', stroke: '#f3e8ff', label: '🌀', score: 32 }
    ];

    // Wall physics settings (bouncy, static, low friction)
    const WALL_OPTIONS = {
        isStatic: true,
        restitution: 0.8,
        friction: 0.1,
        render: {
            visible: false // Keep walls invisible to let circles bounce off literal screen edges
        }
    };

    // ---------------------------------------------------------
    // 2b. Game Mode, Stats & Combo Helpers
    // ---------------------------------------------------------
    function getModeConfig() {
        return isExpertMode ? GAME_MODES.expert : GAME_MODES.classic;
    }

    function getBreachLimit() {
        return getModeConfig().breachLimit;
    }

    function getDropCooldown() {
        return getModeConfig().dropCooldown;
    }

    function getCurrentBest() {
        return isExpertMode ? (gameStats.expertBest || 0) : (gameStats.classicBest || 0);
    }

    function ensureMilestonesState() {
        if (!gameStats.milestones) {
            gameStats.milestones = { first_star: false, first_nebula: false };
        }
        if (gameStats.bestTierReached === undefined) {
            gameStats.bestTierReached = 0;
        }
        if (!gameStats.dailyChallenges) {
            gameStats.dailyChallenges = {};
        }
    }

    function getTodayKey() {
        const d = new Date();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${month}-${day}`;
    }

    function hashDateString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    function pickTodaysChallenge() {
        const dateKey = getTodayKey();
        const index = hashDateString(dateKey) % DAILY_CHALLENGE_POOL.length;
        return { ...DAILY_CHALLENGE_POOL[index], dateKey };
    }

    function isDailyChallengeCompletedToday() {
        ensureMilestonesState();
        const record = gameStats.dailyChallenges[getTodayKey()];
        return Boolean(record && record.completed);
    }

    function getRunChallengeSnapshot() {
        return {
            score,
            maxTier: maxTierThisRun,
            drops: runChallengeState.drops,
            merges: runChallengeState.merges,
            maxCombo: runChallengeState.maxCombo,
            gravityReversed: runChallengeState.gravityReversed || isGravityReversed
        };
    }

    function updateDailyChallengeUI(completedOverride) {
        if (!dailyChallengeEl || !todaysChallenge) return;

        const completed = completedOverride === true || isDailyChallengeCompletedToday();
        dailyChallengeEl.classList.toggle('completed', completed);

        if (completed) {
            dailyChallengeTextEl.textContent = todaysChallenge.title;
            dailyChallengeProgressEl.textContent = 'Challenge complete!';
            return;
        }

        dailyChallengeTextEl.textContent = todaysChallenge.title;
        dailyChallengeProgressEl.textContent = todaysChallenge.progress(getRunChallengeSnapshot());
    }

    async function completeDailyChallenge() {
        if (isDailyChallengeCompletedToday()) return;

        ensureMilestonesState();
        const today = getTodayKey();
        gameStats.dailyChallenges[today] = {
            completed: true,
            completedAt: Date.now(),
            challengeId: todaysChallenge.id
        };
        await persistGameStats();
        updateDailyChallengeUI(true);
        showMilestone('Daily Challenge Complete!', todaysChallenge.title);
        spawnMilestoneBurst(container.clientWidth / 2, container.clientHeight * 0.35);
    }

    function checkDailyChallenge() {
        if (!todaysChallenge || isDailyChallengeCompletedToday()) return;

        const snapshot = getRunChallengeSnapshot();
        updateDailyChallengeUI(false);

        if (todaysChallenge.check(snapshot)) {
            completeDailyChallenge();
        }
    }

    function initDailyChallenge() {
        todaysChallenge = pickTodaysChallenge();
        updateDailyChallengeUI(false);
    }

    function resetRunChallengeState() {
        runChallengeState = {
            drops: 0,
            merges: 0,
            maxCombo: 1,
            gravityReversed: false
        };
    }

    function showMilestone(title, subtitle) {
        if (!milestoneToastEl || !milestoneTitleEl) return;

        milestoneTitleEl.textContent = title;
        if (milestoneSubtitleEl) {
            milestoneSubtitleEl.textContent = subtitle || '';
            milestoneSubtitleEl.style.display = subtitle ? 'block' : 'none';
        }

        milestoneToastEl.classList.remove('hidden');
        clearTimeout(milestoneToastTimer);
        milestoneToastTimer = setTimeout(() => {
            milestoneToastEl.classList.add('hidden');
        }, 2800);
    }

    function spawnMilestoneBurst(x, y) {
        for (let i = 0; i < 20; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 4 + 2;
            particles.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                radius: Math.random() * 4 + 2,
                color: i % 2 === 0 ? '#ffd60a' : '#00f2fe',
                alpha: 1,
                decay: Math.random() * 0.02 + 0.012
            });
        }
    }

    function updateMaxTier(tierIndex) {
        if (tierIndex > maxTierThisRun) {
            maxTierThisRun = tierIndex;
        }
    }

    function checkScoreMilestones() {
        SCORE_MILESTONES.forEach((threshold) => {
            if (score >= threshold && !runCrossedScoreMilestones.has(threshold)) {
                runCrossedScoreMilestones.add(threshold);
                showMilestone(`${threshold} POINTS!`, 'Score milestone reached');
                spawnMilestoneBurst(container.clientWidth / 2, container.clientHeight * 0.22);
            }
        });
    }

    async function celebrateTierMilestone(tierIndex, x, y) {
        ensureMilestonesState();

        const milestoneKey = tierIndex === 3 ? 'first_star' : tierIndex === 4 ? 'first_nebula' : null;
        if (!milestoneKey || gameStats.milestones[milestoneKey]) return;

        gameStats.milestones[milestoneKey] = true;
        const tier = CELESTIAL_TIERS[tierIndex];
        showMilestone(`First ${tier.name}!`, `${tier.label} unlocked`);
        spawnSupernovaEffect(x, y);
        await persistGameStats();
    }

    function resetRunMilestones() {
        runCrossedScoreMilestones.clear();
        maxTierThisRun = 0;
        resetRunChallengeState();
    }

    async function loadGameStats() {
        if (!window.AssetStore?.getGameStats) return;

        try {
            gameStats = await AssetStore.getGameStats();
            isExpertMode = Boolean(gameStats.expertMode);
            ensureMilestonesState();
        } catch (err) {
            console.warn('Could not load game stats:', err);
        }

        initDailyChallenge();
        updateBestScoreDisplay();
        updateExpertModeUI();
    }

    function updateBestScoreDisplay() {
        if (bestScoreCounterEl) {
            bestScoreCounterEl.textContent = getCurrentBest();
        }
    }

    function updateExpertModeUI() {
        if (!expertModeBtn) return;
        expertModeBtn.classList.toggle('active', isExpertMode);
        expertModeBtn.setAttribute('aria-pressed', String(isExpertMode));
    }

    async function persistGameStats() {
        if (!window.AssetStore?.saveGameStats) return;
        gameStats.expertMode = isExpertMode;
        try {
            await AssetStore.saveGameStats(gameStats);
        } catch (err) {
            console.warn('Could not save game stats:', err);
        }
    }

    async function recordGameEnd(finalScore) {
        gameStats.totalGames = (gameStats.totalGames || 0) + 1;
        const bestKey = isExpertMode ? 'expertBest' : 'classicBest';
        const previousBest = gameStats[bestKey] || 0;
        const isNewBest = finalScore > previousBest;

        if (isNewBest) {
            gameStats[bestKey] = finalScore;
        }

        if (maxTierThisRun > (gameStats.bestTierReached || 0)) {
            gameStats.bestTierReached = maxTierThisRun;
        }

        await persistGameStats();
        updateBestScoreDisplay();

        return { isNewBest, bestScore: gameStats[bestKey] };
    }

    function applyComboScore(basePoints, midX, midY) {
        const now = Date.now();

        if (now - lastMergeTime <= COMBO_WINDOW_MS) {
            comboCount += 1;
        } else {
            comboCount = 1;
        }
        lastMergeTime = now;

        const multiplier = comboCount >= 3 ? 3 : comboCount >= 2 ? 2 : 1;
        const points = basePoints * multiplier;

        if (multiplier > 1) {
            comboPopups.push({
                text: `COMBO x${multiplier}`,
                x: midX,
                y: midY - 24,
                alpha: 1,
                life: 72
            });
        }

        if (multiplier > runChallengeState.maxCombo) {
            runChallengeState.maxCombo = multiplier;
        }

        return points;
    }

    function resetComboState() {
        lastMergeTime = 0;
        comboCount = 0;
        comboPopups = [];
    }

    function updateComboPopups() {
        for (let i = comboPopups.length - 1; i >= 0; i--) {
            const popup = comboPopups[i];
            popup.life -= 1;
            popup.y -= 0.6;
            popup.alpha = Math.max(0, popup.life / 72);
            if (popup.life <= 0) {
                comboPopups.splice(i, 1);
            }
        }
    }

    function toggleExpertMode() {
        isExpertMode = !isExpertMode;
        updateExpertModeUI();
        updateBestScoreDisplay();
        persistGameStats();

        if (!isGameOver && engine) {
            currentDropTier = randomDropTier();
            nextDropTier = randomDropTier();
        }
    }

    // ---------------------------------------------------------
    // 3. Matter.js Engine Initialization
    // ---------------------------------------------------------
    // Helper: Select a random tier index based on current mode
    function randomDropTier() {
        const maxTier = getModeConfig().maxDropTier;
        return Math.floor(Math.random() * maxTier);
    }
    async function initPhysics() {
        await resolveAssetUrls();
        await loadGameStats();
        preloadSprites();
        audioManager.init();

        // Create engine (default gravity.y = 1, downward gravity is enabled)
        engine = Engine.create({
            gravity: {
                y: 1,
                scale: 0.001
            },
            enableSleeping: false
        });

        const width = container.clientWidth;
        const height = container.clientHeight;

        // Create Matter.js Renderer
        render = Render.create({
            element: container,
            engine: engine,
            options: {
                width: width,
                height: height,
                wireframes: false,
                background: 'transparent', // CSS handles the layout gradient background
                pixelRatio: Math.min(window.devicePixelRatio || 1, 2) // Support high DPI, capped at 2x for performance
            }
        });

        // Run the renderer
        Render.run(render);

        // Create and run the update loop
        runner = Runner.create();
        Runner.run(runner, engine);

        // Initialize drop shape queue
        currentDropTier = randomDropTier();
        nextDropTier = randomDropTier();
        previewX = width / 2;
        targetX = previewX;

        // Setup boundary walls for the current canvas size
        setupBoundaries();
        
        // Setup Event Listeners
        setupControlBarTouchShield();
        setupEventListeners();

        // Setup custom physics and rendering hooks
        setupPhysicsEvents();

        // Sync canvas to flex layout after mobile browser chrome settles
        requestAnimationFrame(resizePlayfield);
    }

    // ---------------------------------------------------------
    // 4. Boundary Management (Walls & Floor)
    // ---------------------------------------------------------
    function setupBoundaries() {
        // Remove existing walls if this is a resize event
        if (boundaries.length > 0) {
            Composite.remove(engine.world, boundaries);
        }

        const width = container.clientWidth;
        const height = container.clientHeight;
        const thickness = 120; // Thick boundaries to prevent fast-moving objects from tunneling through

        const floor = Bodies.rectangle(width / 2, height + thickness / 2, width + 200, thickness, WALL_OPTIONS);
        const ceiling = Bodies.rectangle(width / 2, -thickness / 2, width + 200, thickness, WALL_OPTIONS);
        const leftWall = Bodies.rectangle(-thickness / 2, height / 2, thickness, height * 2, WALL_OPTIONS);
        const rightWall = Bodies.rectangle(width + thickness / 2, height / 2, thickness, height * 2, WALL_OPTIONS);

        boundaries = [floor, ceiling, leftWall, rightWall];
        Composite.add(engine.world, boundaries);
    }

    // ---------------------------------------------------------
    // 5. Circle Spawning Mechanics (Drop & Merges)
    // ---------------------------------------------------------
    function dropCurrentShape() {
        if (isGameOver || !canDrop || currentDropTier === null) return;

        // Hide tap instructions on first interaction
        if (!hasInteracted) {
            hasInteracted = true;
            instructionEl.classList.add('hidden');
        }

        const tier = CELESTIAL_TIERS[currentDropTier];
        
        // Create circular rigid body, transparent default rendering
        const circle = Bodies.circle(previewX, LAUNCH_Y, tier.radius, {
            restitution: 0.65, // Bouncy circles
            friction: 0.05,    // Sliding resistance
            frictionAir: 0.01, // Drag
            render: {
                fillStyle: 'transparent',
                strokeStyle: 'transparent',
                lineWidth: 0
            }
        });

        registerBodyTier(circle, currentDropTier);

        // Add to the physics simulation world
        Composite.add(engine.world, circle);

        runChallengeState.drops += 1;
        updateMaxTier(currentDropTier);
        celebrateTierMilestone(currentDropTier, previewX, LAUNCH_Y);

        // Play the spawn sound effect
        audioManager.play('spawn');

        // Cooldown before next drop is allowed
        canDrop = false;
        currentDropTier = null; // Hide preview during cooldown
        
        // Update counter immediately
        updateStats();

        // Cooldown timer (500ms) before reloading drop queue
        setTimeout(() => {
            if (isGameOver) return;
            currentDropTier = nextDropTier;
            nextDropTier = randomDropTier();
            canDrop = true;
        }, getDropCooldown());
    }

    function spawnMergedCircle(x, y, tierIndex) {
        const tier = CELESTIAL_TIERS[tierIndex];
        
        const circle = Bodies.circle(x, y, tier.radius, {
            restitution: 0.4,   // slightly less bouncy for merged bodies
            friction: 0.1,      // sliding friction
            frictionAir: 0.012, // drag
            render: {
                fillStyle: 'transparent',
                strokeStyle: 'transparent',
                lineWidth: 0
            }
        });
        
        registerBodyTier(circle, tierIndex);
        Composite.add(engine.world, circle);
    }

    function registerBodyTier(body, tierIndex) {
        body.celestialTier = tierIndex;
        bodyTierById.set(body.id, tierIndex);
    }

    function getBodyTier(body) {
        return bodyTierById.get(body.id);
    }

    function unregisterBody(body) {
        bodyTierById.delete(body.id);
    }

    // ---------------------------------------------------------
    // 6. UI Synchronization & Counters
    // ---------------------------------------------------------
    function updateStats() {
        // Count all bodies in the world that are NOT static boundaries
        const allBodies = Composite.allBodies(engine.world);
        const circleCount = allBodies.filter(body => !body.isStatic).length;

        // Update badge UI
        shapeCounterEl.textContent = circleCount;
        scoreCounterEl.textContent = score;

        // Apply a brief pop/bump animation to the counter badges
        shapeCounterEl.classList.remove('bump');
        scoreCounterEl.classList.remove('bump');
        // Force reflow to restart CSS transition
        void shapeCounterEl.offsetWidth; 
        void scoreCounterEl.offsetWidth; 
        shapeCounterEl.classList.add('bump');
        scoreCounterEl.classList.add('bump');

        checkDailyChallenge();
    }

    function clearAllCircles() {
        const allBodies = Composite.allBodies(engine.world);
        const circles = allBodies.filter(body => !body.isStatic);

        // Safely remove spawned bodies from physics world
        circles.forEach(unregisterBody);
        Composite.remove(engine.world, circles);
        bodyTierById.clear();
        mergedPairsThisStep.clear();
        
        // Reset score, gravity, combo, milestones, and state
        score = 0;
        particles = [];
        resetComboState();
        resetRunMilestones();
        isGameOver = false;
        aboveLineTime = 0;

        if (isGravityReversed) {
            isGravityReversed = false;
            engine.gravity.y = NORMAL_GRAVITY_Y;
            if (gravityToggleBtn) {
                gravityToggleBtn.classList.remove('active');
                gravityToggleBtn.setAttribute('aria-pressed', 'false');
            }
        }
        
        // Hide warning and game over overlay elements
        if (dangerWarningEl) dangerWarningEl.classList.add('hidden');
        if (gameOverOverlayEl) gameOverOverlayEl.classList.add('hidden');
        if (newBestBannerEl) newBestBannerEl.classList.add('hidden');
        if (milestoneToastEl) milestoneToastEl.classList.add('hidden');
        
        // Reload drop queue
        currentDropTier = randomDropTier();
        nextDropTier = randomDropTier();
        previewX = container.clientWidth / 2;
        targetX = previewX;
        canDrop = true;

        // Reset and update counter UI
        updateStats();
    }

    function wakeAllDynamicBodies() {
        Composite.allBodies(engine.world).forEach((body) => {
            if (!body.isStatic) {
                Sleeping.set(body, false);
            }
        });
    }

    function toggleGravity() {
        isGravityReversed = !isGravityReversed;
        engine.gravity.y = isGravityReversed ? REVERSED_GRAVITY_Y : NORMAL_GRAVITY_Y;

        if (isGravityReversed) {
            runChallengeState.gravityReversed = true;
        }

        // Sleeping bodies ignore gravity changes until they are woken
        wakeAllDynamicBodies();

        if (gravityToggleBtn) {
            gravityToggleBtn.classList.toggle('active', isGravityReversed);
            gravityToggleBtn.setAttribute('aria-pressed', String(isGravityReversed));
        }

        checkDailyChallenge();
    }

    function setupControlBarTouchShield() {
        if (!controlBar) return;

        // Bubble phase only — capture:true would intercept events before buttons receive them
        const blockEvent = (event) => {
            event.stopPropagation();
        };

        ['pointerdown', 'pointerup', 'pointermove', 'pointercancel',
         'touchstart', 'touchend', 'touchmove', 'touchcancel', 'click'].forEach((eventName) => {
            controlBar.addEventListener(eventName, blockEvent);
        });
    }

    // ---------------------------------------------------------
    // 7. Physics Event Hooks & Collision Handling
    // ---------------------------------------------------------
    function setupPhysicsEvents() {
        // Smoothly lerp preview shape position before physics updates
        Matter.Events.on(engine, 'beforeUpdate', () => {
            if (canDrop && currentDropTier !== null) {
                const tier = CELESTIAL_TIERS[currentDropTier];
                const radius = tier.radius;
                const width = container.clientWidth;
                // Clamp target X to prevent sphere from spawning partially inside walls
                const clampedTargetX = Math.max(radius + 15, Math.min(width - radius - 15, targetX));
                
                // Smooth interpolation (lerp)
                previewX += (clampedTargetX - previewX) * 0.15;
            }
        });

        Matter.Events.on(engine, 'beforeUpdate', () => {
            mergedPairsThisStep.clear();
        });

        const handleMergeCollisions = (pairs) => {
            const seenPairKeys = new Set();
            const consumedBodies = new Set();

            pairs.forEach((pair) => {
                const bodyA = pair.bodyA;
                const bodyB = pair.bodyB;

                if (bodyA.isStatic || bodyB.isStatic) return;

                const tierA = getBodyTier(bodyA);
                const tierB = getBodyTier(bodyB);
                if (tierA === undefined || tierB === undefined) return;
                if (tierA !== tierB) return;

                const key = mergePairKey(bodyA, bodyB);
                if (seenPairKeys.has(key) || mergedPairsThisStep.has(key)) return;
                if (consumedBodies.has(bodyA.id) || consumedBodies.has(bodyB.id)) return;

                seenPairKeys.add(key);
                consumedBodies.add(bodyA.id);
                consumedBodies.add(bodyB.id);

                tryMerge(bodyA, bodyB, key);
            });
        };

        Matter.Events.on(engine, 'collisionStart', (event) => {
            handleMergeCollisions(event.pairs);
        });

        Matter.Events.on(engine, 'collisionActive', (event) => {
            handleMergeCollisions(event.pairs);
        });

        Matter.Events.on(engine, 'afterUpdate', () => {
            updateParticles();
            updateComboPopups();

            // Check if shapes stack past the launch line (Game Over breaching logic)
            checkLineBreach();
        });

        // Custom canvas graphics overlay
        Matter.Events.on(render, 'afterRender', () => {
            drawCustomOverlay();
        });
    }

    function mergePairKey(bodyA, bodyB) {
        const lo = Math.min(bodyA.id, bodyB.id);
        const hi = Math.max(bodyA.id, bodyB.id);
        return `${lo}:${hi}`;
    }

    function tryMerge(bodyA, bodyB, pairKey) {
        if (!engine.world.bodies.includes(bodyA) || !engine.world.bodies.includes(bodyB)) return;

        mergedPairsThisStep.add(pairKey);
        executeMerge(bodyA, bodyB);
    }

    function executeMerge(bodyA, bodyB) {
        const tier = getBodyTier(bodyA);
        if (tier === undefined) return;

        const midX = (bodyA.position.x + bodyB.position.x) / 2;
        const midY = (bodyA.position.y + bodyB.position.y) / 2;

        unregisterBody(bodyA);
        unregisterBody(bodyB);
        Composite.remove(engine.world, [bodyA, bodyB]);

        runChallengeState.merges += 1;

        const currentTierInfo = CELESTIAL_TIERS[tier];
        let mergePoints = applyComboScore(currentTierInfo.score, midX, midY);
        score += mergePoints;
        spawnMergeParticles(midX, midY, currentTierInfo.color);

        const nextTierIndex = tier + 1;
        if (nextTierIndex < CELESTIAL_TIERS.length) {
            spawnMergedCircle(midX, midY, nextTierIndex);
            updateMaxTier(nextTierIndex);
            celebrateTierMilestone(nextTierIndex, midX, midY);
        } else {
            mergePoints = applyComboScore(100, midX, midY - 36);
            score += mergePoints;
            spawnSupernovaEffect(midX, midY);
        }

        checkScoreMilestones();
        audioManager.play('merge');
        updateStats();
    }

    // ---------------------------------------------------------
    // 8. Launch-Line Breach Detection & Game Over
    // ---------------------------------------------------------
    function isBodyAboveLaunchLine(body) {
        if (body.isStatic) return false;
        const tierIndex = getBodyTier(body);
        if (tierIndex === undefined) return false;
        const tier = CELESTIAL_TIERS[tierIndex];
        if (!tier) return false;
        // Top edge of the circle crosses above the drop launch line
        return body.position.y - tier.radius < LAUNCH_Y;
    }

    function checkLineBreach() {
        if (isGameOver) return;

        const allBodies = Composite.allBodies(engine.world);
        const isBreached = allBodies.some(isBodyAboveLaunchLine);

        if (isBreached) {
            if (aboveLineTime === 0) {
                aboveLineTime = Date.now();
            }

            const elapsed = Date.now() - aboveLineTime;
            const breachLimit = getBreachLimit();
            const secondsRemaining = Math.max(0, (breachLimit - elapsed) / 1000);

            if (dangerWarningEl) {
                dangerWarningEl.classList.remove('hidden');
                dangerWarningEl.textContent = `LINE BREACH! ${secondsRemaining.toFixed(1)}s`;
            }

            if (elapsed >= breachLimit) {
                triggerGameOver();
            }
        } else {
            aboveLineTime = 0;
            if (dangerWarningEl) dangerWarningEl.classList.add('hidden');
        }
    }

    async function triggerGameOver() {
        if (isGameOver) return;

        isGameOver = true;
        canDrop = false;
        currentDropTier = null;

        unlockAudio();
        audioManager.play('gameover');

        const { isNewBest, bestScore } = await recordGameEnd(score);

        if (finalScoreValueEl) finalScoreValueEl.textContent = score;
        if (bestScoreValueEl) bestScoreValueEl.textContent = bestScore;
        if (newBestBannerEl) {
            newBestBannerEl.classList.toggle('hidden', !isNewBest);
        }
        if (gameOverOverlayEl) gameOverOverlayEl.classList.remove('hidden');
        if (dangerWarningEl) dangerWarningEl.classList.add('hidden');
    }

    // ---------------------------------------------------------
    // 9. Visual Particle System
    // ---------------------------------------------------------
    function spawnMergeParticles(x, y, color) {
        for (let i = 0; i < 12; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 3 + 1.5;
            particles.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                radius: Math.random() * 3.5 + 1.5,
                color,
                alpha: 1,
                decay: Math.random() * 0.025 + 0.015
            });
        }
    }

    function spawnSupernovaEffect(x, y) {
        for (let i = 0; i < 35; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 5 + 2.5;
            particles.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                radius: Math.random() * 5.5 + 2,
                color: '#bf5af2', // Nebula purple
                alpha: 1,
                decay: Math.random() * 0.015 + 0.01
            });
        }
    }

    function updateParticles() {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vy += isGravityReversed ? -0.08 : 0.08;
            p.alpha -= p.decay;
            
            if (p.alpha <= 0) {
                particles.splice(i, 1);
            }
        }
    }

    // ---------------------------------------------------------
    // 10. Premium Custom Spherical Graphics Rendering
    // ---------------------------------------------------------
    function drawCelestialSphere(ctx, tier, angle, opacity) {
        ctx.save();
        ctx.globalAlpha = opacity;
        
        // Check if custom sprite texture is preloaded and ready to draw
        const img = spriteImages[tier.tier];
        if (img && img.complete && img.naturalWidth !== 0) {
            // Clip drawing to a circular path matching the celestial body size
            ctx.beginPath();
            ctx.arc(0, 0, tier.radius, 0, Math.PI * 2);
            ctx.clip();
            
            // Draw the sprite centered at (0, 0)
            ctx.drawImage(img, -tier.radius, -tier.radius, tier.radius * 2, tier.radius * 2);
            
            // Draw the glowing outline border
            ctx.strokeStyle = tier.stroke;
            ctx.lineWidth = Math.max(1.5, tier.radius * 0.04);
            ctx.stroke();
        } else {
            // FALLBACK: 3D Spherical Radial Gradient
            // Focus offset highlight slightly up-left
            const grad = ctx.createRadialGradient(
                -tier.radius * 0.2, -tier.radius * 0.2, tier.radius * 0.08,
                0, 0, tier.radius
            );
            grad.addColorStop(0, '#ffffff'); // light sheen
            grad.addColorStop(0.25, tier.color);
            grad.addColorStop(1, tier.darkColor);
            
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(0, 0, tier.radius, 0, Math.PI * 2);
            ctx.fill();
            
            // Glowing Stroke outline
            ctx.strokeStyle = tier.stroke;
            ctx.lineWidth = Math.max(1.5, tier.radius * 0.06);
            ctx.stroke();
            
            // Central Emoji representation (does not rotate with body for readability)
            ctx.rotate(-angle); // counter-rotate so emoji is always upright!
            ctx.font = `${tier.radius * 0.75}px "Outfit", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tier.label, 0, 0);
        }
        
        ctx.restore();
    }

    function drawCustomOverlay() {
        const ctx = render.context;
        const width = render.options.width;
        const height = render.options.height;

        // 1. Draw Launch Zone boundary line (pulses red if breached)
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([6, 6]);
        if (aboveLineTime > 0) {
            // Pulse between bright red and soft red based on game timestamp
            const pulse = (Math.sin(Date.now() / 150) + 1) / 2;
            ctx.strokeStyle = `rgba(255, 69, 58, ${0.3 + pulse * 0.5})`;
            ctx.lineWidth = 2.5;
        } else {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = 1.5;
        }
        ctx.moveTo(0, LAUNCH_Y);
        ctx.lineTo(width, LAUNCH_Y);
        ctx.stroke();
        ctx.restore();

        // 2. Draw Drop Preview and Guide Line if user is ready to drop
        if (canDrop && currentDropTier !== null) {
            const tier = CELESTIAL_TIERS[currentDropTier];
            
            // Guide line down to the bottom
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([4, 10]);
            ctx.strokeStyle = `${tier.color}40`; // 25% opacity color using hex+alpha
            ctx.lineWidth = 2;
            ctx.moveTo(previewX, LAUNCH_Y);
            ctx.lineTo(previewX, height);
            ctx.stroke();
            ctx.restore();

            // Preview sphere at launch position
            ctx.save();
            ctx.translate(previewX, LAUNCH_Y);
            drawCelestialSphere(ctx, tier, 0, 0.7); // 70% opacity for preview

            if (getModeConfig().showTierNames) {
                ctx.rotate(0);
                ctx.font = '700 11px "Outfit", sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.shadowBlur = 6;
                ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
                ctx.fillText(tier.name.toUpperCase(), 0, tier.radius + 6);
            }
            ctx.restore();
        }

        // 3. Draw All Active Celestial Bodies
        const allBodies = Composite.allBodies(engine.world);
        allBodies.forEach(body => {
            if (body.isStatic) return; // Skip walls
            const tierIndex = getBodyTier(body);
            if (tierIndex === undefined) return;
            
            const tier = CELESTIAL_TIERS[tierIndex];
            if (!tier) return;
            
            ctx.save();
            ctx.translate(body.position.x, body.position.y);
            ctx.rotate(body.angle);
            drawCelestialSphere(ctx, tier, body.angle, 1.0);
            ctx.restore();
        });

        // 4. Render Particle System
        ctx.save();
        particles.forEach(p => {
            ctx.globalAlpha = p.alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.restore();

        // 5. Draw Score in top-left
        ctx.save();
        ctx.font = '800 24px "Outfit", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0, 242, 254, 0.5)';
        ctx.fillText(`SCORE: ${score}`, 24, 40);

        if (isExpertMode) {
            ctx.font = '700 11px "Outfit", sans-serif';
            ctx.fillStyle = 'rgba(255, 204, 0, 0.9)';
            ctx.shadowBlur = 0;
            ctx.fillText('EXPERT MODE', 24, 58);
        }
        ctx.restore();

        // 6. Draw "Next Up" box in top-right
        if (nextDropTier !== null) {
            const nextTier = CELESTIAL_TIERS[nextDropTier];
            
            ctx.save();
            // Glassmorphic panel
            ctx.fillStyle = 'rgba(8, 12, 24, 0.6)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(width - 110, 16, 90, 90, 12);
            } else {
                ctx.rect(width - 110, 16, 90, 90);
            }
            ctx.fill();
            ctx.stroke();
            
            // Panel Label
            ctx.font = '600 11px "Outfit", sans-serif';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.textAlign = 'center';
            ctx.fillText('NEXT', width - 65, 34);
            
            // Draw next body inside preview box (clamped size)
            ctx.translate(width - 65, 66);
            const displayRadius = Math.min(22, nextTier.radius);
            
            // Scale rendering parameters just for the small panel
            const scale = displayRadius / nextTier.radius;
            ctx.scale(scale, scale);
            drawCelestialSphere(ctx, nextTier, 0, 1.0);

            if (getModeConfig().showTierNames) {
                ctx.font = '600 9px "Outfit", sans-serif';
                ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(nextTier.name, 0, nextTier.radius + 10);
            }
            ctx.restore();
        }

        // 7. Combo popups
        ctx.save();
        comboPopups.forEach((popup) => {
            ctx.globalAlpha = popup.alpha;
            ctx.font = '800 18px "Outfit", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffd60a';
            ctx.shadowBlur = 12;
            ctx.shadowColor = 'rgba(255, 214, 10, 0.6)';
            ctx.fillText(popup.text, popup.x, popup.y);
        });
        ctx.restore();
    }

    // ---------------------------------------------------------
    // 11. Event Handlers & Resize Listeners
    // ---------------------------------------------------------
    function unlockAudio() {
        audioManager.init();
        audioManager.resume();
    }

    function setupEventListeners() {
        // Pointer events handle touch, mouse, and stylus input uniformly
        container.addEventListener('pointerdown', (event) => {
            unlockAudio();
            isPointerDown = true;
            const rect = render.canvas.getBoundingClientRect();
            targetX = event.clientX - rect.left;
        });

        container.addEventListener('pointermove', (event) => {
            const rect = render.canvas.getBoundingClientRect();
            targetX = event.clientX - rect.left;
        });

        container.addEventListener('pointerup', () => {
            if (isPointerDown) {
                isPointerDown = false;
                dropCurrentShape();
            }
        });

        container.addEventListener('pointerleave', () => {
            isPointerDown = false;
        });

        // Control console buttons — pointerup only (click would double-fire after pointerup)
        function bindConsoleButton(button, handler) {
            if (!button) return;
            button.addEventListener('pointerup', (event) => {
                event.stopPropagation();
                event.preventDefault();
                handler();
            });
        }

        bindConsoleButton(resetBtn, clearAllCircles);
        bindConsoleButton(gravityToggleBtn, toggleGravity);
        bindConsoleButton(expertModeBtn, toggleExpertMode);

        if (restartBtn) {
            restartBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                unlockAudio();
                if (newBestBannerEl) newBestBannerEl.classList.add('hidden');
                clearAllCircles();
            });
        }

        resizePlayfield();

        // Window resize + mobile visual viewport (browser chrome show/hide)
        window.addEventListener('resize', resizePlayfield);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', resizePlayfield);
        }

        // Reflow when the console wraps and changes height (common on phones)
        if (typeof ResizeObserver !== 'undefined') {
            const layoutObserver = new ResizeObserver(resizePlayfield);
            layoutObserver.observe(container);
            if (controlBar) layoutObserver.observe(controlBar);
        }
    }

    function resizePlayfield() {
        if (!render || !engine) return;

        const width = container.clientWidth;
        const height = container.clientHeight;
        const pixelRatio = render.options.pixelRatio || 1;

        render.canvas.width = width * pixelRatio;
        render.canvas.height = height * pixelRatio;
        render.canvas.style.width = width + 'px';
        render.canvas.style.height = height + 'px';

        render.options.width = width;
        render.options.height = height;

        render.bounds.min.x = 0;
        render.bounds.min.y = 0;
        render.bounds.max.x = width;
        render.bounds.max.y = height;

        setupBoundaries();
    }

    // ---------------------------------------------------------
    // 12. Lifecycle Bootstrapper
    // ---------------------------------------------------------
    window.addEventListener('DOMContentLoaded', () => {
        initPhysics();
    });

    // Reload custom assets when returning from Asset Studio (bfcache restore)
    window.addEventListener('pageshow', (event) => {
        if (event.persisted && engine) {
            reloadCustomAssets();
        }
    });

    window.reloadCustomAssets = reloadCustomAssets;
})();
