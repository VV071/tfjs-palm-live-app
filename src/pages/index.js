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
  const phaseRef = useRef("action");
  const phaseStartRef = useRef(0);
  const holdFramesRef = useRef([]);

  const [status, setStatus] = useState("Loading models...");
  const [progress, setProgress] = useState(0);

  const ACTION_TIME = 4000;
  const HOLD_TIME = 5000;
  const GUIDE_BOX_RATIO = 0.6;

  useEffect(() => {
    const init = async () => {
      const auth = getAuth(app);
      signInAnonymously(auth).catch(console.error);

      try {
        // Load MediaPipe HandLandmarker
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

        // Start camera
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        videoRef.current.srcObject = stream;

        // Wait for video metadata
        await new Promise(resolve => {
          videoRef.current.onloadedmetadata = () => resolve(true);
        });

        await videoRef.current.play();

        // Set canvas size
        canvasRef.current.width = videoRef.current.videoWidth;
        canvasRef.current.height = videoRef.current.videoHeight;

        setStatus("Move your hand inside the guide box...");
        detectLoop();
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

  const drawLandmarks = (ctx, landmarks) => {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    const cx = ctx.canvas.width / 2;
    const cy = ctx.canvas.height / 2;
    const size = Math.min(ctx.canvas.width, ctx.canvas.height) * GUIDE_BOX_RATIO;

    // Guide box
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
    ctx.restore();

    // Landmarks
    if (landmarks) {
      ctx.fillStyle = "rgba(124,58,237,0.95)";
      landmarks.forEach(lm => {
        ctx.beginPath();
        ctx.arc(lm.x * ctx.canvas.width, lm.y * ctx.canvas.height, 5, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
  };

  const isHandInBox = (landmarks, width, height) => {
    const cx = width / 2;
    const cy = height / 2;
    const size = Math.min(width, height) * GUIDE_BOX_RATIO;
    return landmarks.every(lm => {
      const x = lm.x * width;
      const y = lm.y * height;
      return x >= cx - size / 2 && x <= cx + size / 2 && y >= cy - size / 2 && y <= cy + size / 2;
    });
  };

  const detectLoop = async () => {
    if (!videoRef.current || !handRef.current) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    // Skip if video not ready
    if (videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    try {
      const results = await handRef.current.detectForVideo(videoRef.current, performance.now());
      if (results?.landmarks?.length > 0) {
        handleHand(results.landmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z || 0 })));
      } else {
        holdFramesRef.current = [];
        phaseRef.current = "action";
        phaseStartRef.current = performance.now();
        setProgress(0);
        setStatus("Show your hand inside the guide box...");
      }
    } catch (err) {
      console.warn("Hand detection skipped for this frame:", err);
    }

    rafRef.current = requestAnimationFrame(detectLoop);
  };

  const handleHand = async (landmarks) => {
    const ctx = canvasRef.current.getContext("2d");
    drawLandmarks(ctx, landmarks);

    if (!isHandInBox(landmarks, ctx.canvas.width, ctx.canvas.height)) {
      setStatus("Keep your hand inside the guide box...");
      return;
    }

    const now = performance.now();
    const elapsed = now - phaseStartRef.current;

    if (phaseRef.current === "action") {
      setProgress(Math.min(elapsed / ACTION_TIME, 1));
      setStatus(`Move your hand (${Math.floor(Math.min(elapsed / ACTION_TIME * 100, 100))}%)`);
      if (elapsed >= ACTION_TIME) {
        phaseRef.current = "hold";
        phaseStartRef.current = now;
        holdFramesRef.current = [];
        setProgress(0);
        setStatus("Hold your hand steady for 5 seconds...");
      }
    } else if (phaseRef.current === "hold") {
      holdFramesRef.current.push(landmarks);
      setProgress(Math.min(elapsed / HOLD_TIME, 1));
      setStatus(`Hold steady (${Math.floor(Math.min(elapsed / HOLD_TIME * 100, 100))}%)`);

      if (elapsed >= HOLD_TIME) {
        setProgress(1);
        setStatus("Saving your palm embedding… 🎉");
        phaseRef.current = "done";
        saveEmbedding();
      }
    }
  };

  const saveEmbedding = async () => {
  if (!holdFramesRef.current.length) {
    setStatus("No hand detected. Try again ✋");
    phaseRef.current = "action";
    setProgress(0);
    return;
  }

  // Average landmarks (x, y, z)
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

  const db = getFirestore(app);
  await addDoc(collection(db, "embeddings"), {
    embedding: averaged,
    timestamp: Date.now(),
    userId: getAuth(app).currentUser?.uid || "unknown",
  });

  confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
  setStatus("🌟 Palm embedding saved! 🎉");

  setTimeout(() => {
    phaseRef.current = "action";
    setProgress(0);
    holdFramesRef.current = [];
    setStatus("Move your hand inside the guide box...");
  }, 3000);
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
            <video ref={videoRef} className="rounded-lg w-full" autoPlay muted playsInline />
            <canvas ref={canvasRef} className="absolute left-0 top-0 w-full h-full pointer-events-none" />
          </div>
          <p className="text-gray-200 text-center">{status}</p>
          <div className="w-full bg-gray-200 h-2 rounded">
            <div className="bg-purple-600 h-2 rounded" style={{ width: `${Math.min(progress,1)*100}%` }} />
          </div>
          <Button
            className="mt-4"
            onClick={() => {
              phaseRef.current = "action";
              phaseStartRef.current = performance.now();
              holdFramesRef.current = [];
            }}
          >
            🖐️ Start Palm Capture
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
