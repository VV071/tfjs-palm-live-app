import { useEffect, useRef, useState } from "react";
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore, collection, addDoc } from "firebase/firestore";
import confetti from "canvas-confetti";
import { app } from "../utils/firebase";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export default function Home() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handRef = useRef(null);
  const rafRef = useRef(null);

  const phaseRef = useRef("idle"); // idle | rules | game | postHit | finished
  const phaseStartRef = useRef(0);
  const holdFramesRef = useRef([]);
  const gameStartRef = useRef(0);

  const [status, setStatus] = useState("Loading models...");
  const [progress, setProgress] = useState(0);
  const [score, setScore] = useState(0);
  const [target, setTarget] = useState({ x: 0.5, y: 0.5 });
  const [rulesCountdown, setRulesCountdown] = useState(7);
  const [gameTimeLeft, setGameTimeLeft] = useState(30);

  const ACTION_HOLD_TIME = 5000; // 5 seconds for post-hit
  const RULES_TIME = 10000; // 10 seconds
  const GAME_TIME = 60000; // 60 seconds

  // Detect mobile and adjust target size
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const TARGET_RADIUS = isMobile ? 0.12 : 0.07; // bigger target for mobile

  // Helper: check if palm is wide open
  const isPalmOpen = (landmarks) => {
    if (!landmarks || landmarks.length < 21) return false;
    // simple heuristic: distance between tips and wrist normalized
    const wrist = landmarks[0];
    const middleTip = landmarks[12];
    const ringTip = landmarks[16];
    const indexTip = landmarks[8];
    const pinkyTip = landmarks[20];
    const thumbTip = landmarks[4];

    const spread =
      Math.abs(indexTip.x - pinkyTip.x) +
      Math.abs(thumbTip.x - indexTip.x) +
      Math.abs(middleTip.x - ringTip.x);

    // adjust threshold if needed (0.15 is a rough normalized value)
    return spread > 0.15;
  };

  // Initialize hand model and camera
  useEffect(() => {
    const init = async () => {
      try {
        const auth = getAuth(app);
        signInAnonymously(auth).catch(() => console.log("Firebase auth skipped"));

        const fileset = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        handRef.current = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/models/hand_landmarker.task" },
          runningMode: "VIDEO",
          numHands: 1,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.5,
        });

        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        videoRef.current.srcObject = stream;
        await new Promise(resolve => (videoRef.current.onloadedmetadata = () => resolve(true)));
        await videoRef.current.play();

        canvasRef.current.width = videoRef.current.videoWidth;
        canvasRef.current.height = videoRef.current.videoHeight;

        setStatus("Press 'Start' to begin!");
      } catch (err) {
        console.error("Initialization failed:", err);
        setStatus("Failed to load hand detection model 😢");
      }
    };
    init();

    return () => {
      videoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
      handRef.current?.close();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Main loop
  useEffect(() => {
    const detectLoop = async () => {
      if (!videoRef.current || !handRef.current) {
        rafRef.current = requestAnimationFrame(detectLoop);
        return;
      }

      if (videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) {
        rafRef.current = requestAnimationFrame(detectLoop);
        return;
      }

      try {
        const results = await handRef.current.detectForVideo(videoRef.current, performance.now());
        const ctx = canvasRef.current.getContext("2d");
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        // Draw target
        if (phaseRef.current === "game") {
          ctx.fillStyle = isMobile ? "rgba(255,0,0,0.5)" : "rgba(255,0,0,0.6)";
          ctx.beginPath();
          ctx.arc(target.x * ctx.canvas.width, target.y * ctx.canvas.height, TARGET_RADIUS * ctx.canvas.width, 0, 2 * Math.PI);
          ctx.fill();
        }

        // Draw landmarks
        if (results?.landmarks?.length > 0) {
          const landmarks = results.landmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z || 0 }));
          drawLandmarks(ctx, landmarks);

          const wrist = landmarks[0]; // landmark 0 is wrist

          switch (phaseRef.current) {
            case "rules":
              updateRulesPhase();
              break;
            case "game":
              updateGamePhase(wrist);
              break;
            case "postHit":
              updatePostHitPhase(landmarks);
              break;
          }
        } else {
          if (phaseRef.current === "rules") setRulesCountdown(7); // reset rules countdown if no hand
        }
      } catch (err) {
        console.warn("Frame skipped:", err);
      }

      rafRef.current = requestAnimationFrame(detectLoop);
    };

    rafRef.current = requestAnimationFrame(detectLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  // Draw hand landmarks
  const drawLandmarks = (ctx, landmarks) => {
    ctx.fillStyle = "rgba(124,58,237,0.95)";
    landmarks.forEach(lm => {
      ctx.beginPath();
      ctx.arc(lm.x * ctx.canvas.width, lm.y * ctx.canvas.height, 5, 0, 2 * Math.PI);
      ctx.fill();
    });
  };

  // RULES PHASE
  const updateRulesPhase = () => {
    const now = performance.now();
    const elapsed = now - phaseStartRef.current;
    const remaining = Math.max(0, RULES_TIME - elapsed);
    setRulesCountdown(Math.ceil(remaining / 1000));

    setStatus(
      `📖 Rules: Move your wrist to the red dot to score. After each hit, show a wide-open palm for 5s to capture embedding. Countdown: ${Math.ceil(remaining / 1000)}s`
    );

    if (elapsed >= RULES_TIME) {
      phaseRef.current = "game";
      phaseStartRef.current = now;
      gameStartRef.current = now;
      setGameTimeLeft(60);
      setStatus("🎮 Game started! Move your wrist to the target.");
    }
  };

  // GAME PHASE
  const updateGamePhase = (wrist) => {
    const now = performance.now();
    const elapsed = now - gameStartRef.current;
    setGameTimeLeft(Math.max(0, Math.ceil((GAME_TIME - elapsed) / 1000)));

    // Game ends after GAME_TIME
    if (elapsed >= GAME_TIME) {
      phaseRef.current = "finished";
      setStatus(`🏁 Game over! Final Score: ${score}`);
      return;
    }

    // Check if wrist hits target
    const dx = wrist.x - target.x;
    const dy = wrist.y - target.y;
    if (Math.sqrt(dx * dx + dy * dy) < TARGET_RADIUS) {
      setScore(prev => prev + 1);
      setTarget({ x: Math.random(), y: Math.random() });
      phaseRef.current = "postHit";
      phaseStartRef.current = performance.now();
      holdFramesRef.current = [];
      setProgress(0);
      setStatus("✋ Show a wide-open palm for 5 seconds!");
    }
  };

  // POST-HIT PHASE (reset timer if palm closes)
  const updatePostHitPhase = (landmarks) => {
    if (!isPalmOpen(landmarks)) {
      // Palm closed → reset timer
      phaseStartRef.current = performance.now();
      holdFramesRef.current = [];
      setProgress(0);
      setStatus("✋ Keep your palm wide open! Timer reset.");
      return;
    }

    // Palm open → accumulate frames
    holdFramesRef.current.push(landmarks);
    const now = performance.now();
    const elapsed = now - phaseStartRef.current;
    setProgress(Math.min(elapsed / ACTION_HOLD_TIME, 1));

    if (elapsed >= ACTION_HOLD_TIME) {
      saveEmbedding();
      phaseRef.current = "game";
      phaseStartRef.current = now;
      setProgress(0);
      setStatus("🎮 Back to game! Move your wrist to the next target.");
      holdFramesRef.current = [];
    }
  };

  const saveEmbedding = async () => {
    if (!holdFramesRef.current.length) return;

    const numLandmarks = holdFramesRef.current[0].length;
    const averaged = [];

    for (let i = 0; i < numLandmarks; i++) {
      const sum = { x: 0, y: 0, z: 0 };
      holdFramesRef.current.forEach(frame => {
        sum.x += frame[i].x;
        sum.y += frame[i].y;
        sum.z += frame[i].z;
      });
      averaged.push({
        x: sum.x / holdFramesRef.current.length,
        y: sum.y / holdFramesRef.current.length,
        z: sum.z / holdFramesRef.current.length,
      });
    }

    try {
      const db = getFirestore(app);
      await addDoc(collection(db, "embeddings"), {
        embedding: averaged,
        timestamp: Date.now(),
        userId: getAuth(app).currentUser?.uid || "unknown",
      });
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      console.log("Palm embedding saved!");
    } catch (err) {
      console.error("Failed to save embedding:", err);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-500 to-indigo-600 flex items-center justify-center p-6">
      <Card className="max-w-lg w-full shadow-xl relative">
        <CardHeader>
          <CardTitle className="text-center text-2xl font-bold">
            PalmPay Live Demo 🌟
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <div className="relative w-full">
            <video
              ref={videoRef}
              className="rounded-lg w-full"
              autoPlay
              muted
              playsInline
            />
            <canvas
              ref={canvasRef}
              className="absolute left-0 top-0 w-full h-full pointer-events-none"
            />
          </div>
          <p className="text-gray-200 text-center">{status}</p>
          {phaseRef.current === "rules" && (
            <p className="text-yellow-300 text-center font-bold">
              Rules Countdown: {rulesCountdown}s
            </p>
          )}
          {phaseRef.current === "game" && (
            <p className="text-green-300 text-center font-bold">
              Game Time Left: {gameTimeLeft}s | Score: {score}
            </p>
          )}
          {(phaseRef.current === "postHit" || phaseRef.current === "game") && (
            <div className="w-full bg-gray-200 h-2 rounded">
              <div
                className="bg-purple-600 h-2 rounded"
                style={{ width: `${Math.min(progress, 1) * 100}%` }}
              />
            </div>
          )}
          {phaseRef.current === "idle" && (
            <Button
              className="mt-4"
              onClick={() => {
                phaseRef.current = "rules";
                phaseStartRef.current = performance.now();
                setRulesCountdown(7);
              }}
            >
              🖐️ Start Palm Game
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
