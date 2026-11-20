"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Mic,
  MicOff,
  PhoneOff,
  ChevronDown,
  Loader2,
  AlertCircle,
} from "lucide-react";

/*
  VIVA Voice - Voice-only oral examination app

  Backend WebSocket messages sent:
    { type: "start_session", class, subject }
    { type: "answer", text }

  Backend messages received:
    { type: "session_id", id }
    { type: "question", text }
    { type: "audio", data, mime }
    { type: "status", state: "thinking" | "listening" }
    { type: "end" }
    { type: "error", text }

  IMPORTANT:
  The browser does NOT immediately submit an answer when SpeechRecognition
  reports a final result.

  Instead:
    1. Speech is accumulated.
    2. Every new speech result resets the silence timer.
    3. The answer is submitted only after ANSWER_SILENCE_MS of silence.

  This prevents the examiner from responding after only ~2 seconds
  when the student is still thinking.
*/

const CLASS_OPTIONS = ["6", "7", "8", "9", "10", "11", "12", "B. Tech"];

const SUBJECT_OPTIONS = [
  "Mathematics",
  "Physics",
  "Chemistry",
  "Biology",
  "English",
  "History",
  "Geography",
  "Computer Science",
  "Economics",
  "Machine Learning"
];

/*
  How long the student must remain silent before the answer is submitted.

  5000 = 5 seconds.

  You can change this to:
    4000 = 4 seconds
    5000 = 5 seconds
    6000 = 6 seconds
*/
const ANSWER_SILENCE_MS = 5000;

const DEMO_QUESTIONS: Record<string, string[]> = {
  Mathematics: [
    "What is the difference between a rational and an irrational number?",
    "State the Pythagorean theorem and tell me where it applies.",
    "How would you find the roots of a quadratic equation?",
    "What does the slope of a line tell you about a graph?",
  ],

  Physics: [
    "State Newton's second law of motion in your own words.",
    "What is the difference between speed and velocity?",
    "Explain why a heavier object doesn't fall faster in a vacuum.",
    "What happens to the resistance of a wire as its length increases?",
  ],

  Chemistry: [
    "What distinguishes an ionic bond from a covalent bond?",
    "Explain what a catalyst does in a chemical reaction.",
    "Why does the pH scale run from 0 to 14?",
    "What is the difference between an element and a compound?",
  ],

  Biology: [
    "Walk me through the basic stages of photosynthesis.",
    "What is the function of mitochondria in a cell?",
    "How does natural selection lead to evolution over time?",
    "Explain the difference between arteries and veins.",
  ],

  English: [
    "What makes a metaphor different from a simile?",
    "Tell me about a book that changed how you see something.",
    "What is the purpose of a thesis statement in an essay?",
    "How would you identify the tone of a passage?",
  ],

  History: [
    "What were the main causes of the First World War?",
    "How did the Industrial Revolution change daily life?",
    "Explain the significance of any one freedom movement you've studied.",
    "What is the difference between a primary and secondary source?",
  ],

  Geography: [
    "What causes the formation of monsoon winds?",
    "Explain the difference between weather and climate.",
    "How do tectonic plates contribute to earthquakes?",
    "What factors influence the location of a major city?",
  ],

  "Computer Science": [
    "What is the difference between a compiler and an interpreter?",
    "Explain what a variable is, as if to someone new to programming.",
    "What is the purpose of a loop in a program?",
    "How does a stack differ from a queue?",
  ],

  Economics: [
    "What is the law of demand?",
    "Explain the difference between a need and a want in economic terms.",
    "What causes inflation?",
    "How does supply affect the price of a good?",
  ],
};

function formatTime(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");

  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");

  return `${m}:${s}`;
}

// ------------------------------------------------------------
// Browser TTS fallback
// ------------------------------------------------------------

function speak(text: string, onEnd?: () => void) {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window)
  ) {
    onEnd?.();
    return;
  }

  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);

  utter.rate = 0.98;
  utter.pitch = 1;
  utter.lang = "en-IN";

  utter.onend = () => onEnd?.();
  utter.onerror = () => onEnd?.();

  window.speechSynthesis.speak(utter);
}

export default function VivaApp() {
  // ------------------------------------------------------------
  // UI state
  // ------------------------------------------------------------

  const [screen, setScreen] = useState<"setup" | "session">("setup");

  const [selectedClass, setSelectedClass] = useState("");
  const [selectedSubject, setSelectedSubject] = useState("");

  const [wsUrl, setWsUrl] = useState("ws://localhost:8000/ws");

  const [connectionStatus, setConnectionStatus] = useState("idle");
  const [aiState, setAiState] = useState("idle");

  const [transcript, setTranscript] = useState<
    {
      speaker: string;
      text: string;
      id: string;
    }[]
  >([]);

  const [micEnabled, setMicEnabled] = useState(false);
  const [micError, setMicError] = useState("");

  const [interimText, setInterimText] = useState("");
  const [manualText, setManualText] = useState("");

  const [elapsed, setElapsed] = useState(0);

  const [bars, setBars] = useState<number[]>(
    new Array(28).fill(4)
  );

  // ------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------

  const socketRef = useRef<WebSocket | null>(null);

  const recognitionRef = useRef<any>(null);

  const audioCtxRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
  } | null>(null);

  const rafRef = useRef<number | null>(null);

  const timerRef = useRef<number | null>(null);

  const answerTimerRef = useRef<number | null>(null);

  const demoIndexRef = useRef(0);

  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // ------------------------------------------------------------
  // AI response buffering
  // ------------------------------------------------------------

  const aiBufferRef = useRef("");

  const pendingAudioRef = useRef<string | null>(null);

  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // ------------------------------------------------------------
  // Voice state
  // ------------------------------------------------------------

  const speakingRef = useRef(false);

  const micEnabledRef = useRef(false);

  const endedRef = useRef(false);

  // ------------------------------------------------------------
  // Student answer buffering
  // ------------------------------------------------------------

  /*
    This is the most important change.

    SpeechRecognition can produce multiple final results.

    We collect all of them here instead of immediately sending
    every final result to Gemini.
  */
  const answerBufferRef = useRef("");

  /*
    Prevents the same answer from being submitted twice.
  */
  const answerSubmittingRef = useRef(false);

  /*
    Keeps the latest sendAnswer function available to
    SpeechRecognition callbacks.
  */
  const sendAnswerRef = useRef<(text: string) => void>(() => {});

  const subjectRef = useRef("");

  // ------------------------------------------------------------
  // Browser speech recognition support
  // ------------------------------------------------------------

  const speechSupported =
    typeof window !== "undefined" &&
    Boolean(
      (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition
    );

  // ------------------------------------------------------------
  // Scroll transcript
  // ------------------------------------------------------------

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [transcript, interimText]);

  // ------------------------------------------------------------
  // Transcript helper
  // ------------------------------------------------------------

  const pushTranscript = useCallback(
    (speaker: string, text: string) => {
      setTranscript((current) => [
        ...current,
        {
          speaker,
          text,
          id: `${Date.now()}-${Math.random()}`,
        },
      ]);
    },
    []
  );

  // ------------------------------------------------------------
  // Clear answer timer
  // ------------------------------------------------------------

  const clearAnswerTimer = useCallback(() => {
    if (answerTimerRef.current !== null) {
      window.clearTimeout(answerTimerRef.current);
      answerTimerRef.current = null;
    }
  }, []);

  // ------------------------------------------------------------
  // Examiner speaks
  // ------------------------------------------------------------

  const examinerSay = useCallback(
    (text: string, audioB64?: string) => {
      pushTranscript("ai", text);

      setAiState("speaking");

      speakingRef.current = true;

      /*
        Make sure no student answer is waiting while the
        examiner is speaking.
      */
      clearAnswerTimer();

      answerBufferRef.current = "";
      answerSubmittingRef.current = false;

      setInterimText("");

      const done = () => {
        speakingRef.current = false;

        if (endedRef.current) {
          setAiState("idle");
        } else if (micEnabledRef.current) {
          setAiState("listening");
        } else {
          setAiState("idle");
        }
      };

      if (audioB64) {
        const audio = new Audio(
          `data:audio/mpeg;base64,${audioB64}`
        );

        audioElRef.current = audio;

        audio.onended = done;

        audio.onerror = () => {
          speak(text, done);
        };

        audio.play().catch(() => {
          speak(text, done);
        });
      } else {
        speak(text, done);
      }
    },
    [pushTranscript, clearAnswerTimer]
  );

  // ------------------------------------------------------------
  // Microphone visualizer
  // ------------------------------------------------------------

  const startMicVisualizer = useCallback(async () => {
    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

      const AudioCtx =
        window.AudioContext ||
        (window as any).webkitAudioContext;

      const ctx = new AudioCtx();

      const source = ctx.createMediaStreamSource(stream);

      const analyser = ctx.createAnalyser();

      analyser.fftSize = 64;

      source.connect(analyser);

      audioCtxRef.current = {
        ctx,
        stream,
      };

      setMicError("");

      const data = new Uint8Array(
        analyser.frequencyBinCount
      );

      const tick = () => {
        analyser.getByteFrequencyData(data);

        setBars(
          Array.from(data.slice(0, 28)).map((v) =>
            Math.max(4, (v / 255) * 46)
          )
        );

        rafRef.current =
          requestAnimationFrame(tick);
      };

      tick();
    } catch (err) {
      setMicError(
        "Microphone access was blocked. Allow microphone access in your browser's site settings, then reload."
      );
    }
  }, []);

  const stopMicVisualizer = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.stream
        .getTracks()
        .forEach((track) => track.stop());

      audioCtxRef.current.ctx.close();

      audioCtxRef.current = null;
    }

    setBars(new Array(28).fill(4));
  }, []);

  // ------------------------------------------------------------
  // Demo examiner
  // ------------------------------------------------------------

  const runDemoTurn = useCallback(() => {
    setAiState("thinking");

    const bank =
      DEMO_QUESTIONS[subjectRef.current] ||
      DEMO_QUESTIONS.Mathematics;

    window.setTimeout(() => {
      const index = demoIndexRef.current;

      if (index >= bank.length) {
        endedRef.current = true;

        examinerSay(
          "That concludes the viva. Well answered."
        );

        return;
      }

      demoIndexRef.current += 1;

      examinerSay(bank[index]);
    }, 900);
  }, [examinerSay]);

  // ------------------------------------------------------------
  // Send student answer
  // ------------------------------------------------------------

  const sendAnswer = useCallback(
    (text: string) => {
      const cleanText = text.trim();

      if (!cleanText) return;

      if (endedRef.current) return;

      /*
        Prevent duplicate submission.
      */
      if (answerSubmittingRef.current) return;

      answerSubmittingRef.current = true;

      clearAnswerTimer();

      answerBufferRef.current = "";

      setInterimText("");

      pushTranscript("you", cleanText);

      const ws = socketRef.current;

      if (
        ws &&
        ws.readyState === WebSocket.OPEN
      ) {
        setAiState("thinking");

        ws.send(
          JSON.stringify({
            type: "answer",
            text: cleanText,
          })
        );
      } else if (!ws) {
        runDemoTurn();
      } else {
        answerSubmittingRef.current = false;
      }
    },
    [pushTranscript, runDemoTurn, clearAnswerTimer]
  );

  useEffect(() => {
    sendAnswerRef.current = sendAnswer;
  }, [sendAnswer]);

  // ------------------------------------------------------------
  // Schedule answer submission
  // ------------------------------------------------------------

  const scheduleAnswerSubmission = useCallback(() => {
    clearAnswerTimer();

    const answer = answerBufferRef.current.trim();

    if (!answer) return;

    /*
      Do not submit while examiner is speaking.
    */
    if (speakingRef.current) return;

    /*
      Do not submit if already submitted.
    */
    if (answerSubmittingRef.current) return;

    /*
      Wait for the configured silence period.

      If the student speaks again, this timer is
      cancelled and restarted.
    */
    answerTimerRef.current = window.setTimeout(() => {
      const finalAnswer =
        answerBufferRef.current.trim();

      if (!finalAnswer) return;

      if (speakingRef.current) return;

      if (answerSubmittingRef.current) return;

      sendAnswerRef.current(finalAnswer);
    }, ANSWER_SILENCE_MS);
  }, [clearAnswerTimer]);

  // ------------------------------------------------------------
  // Speech recognition
  // ------------------------------------------------------------

  const startRecognition = useCallback(() => {
    if (!speechSupported) return;

    /*
      Don't create multiple recognition instances.
    */
    if (recognitionRef.current) return;

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) return;

    const rec = new SpeechRecognition();

    /*
      Keep recognition running as long as possible.
    */
    rec.continuous = true;

    /*
      We need interim results so the UI can show
      what the student is currently saying.
    */
    rec.interimResults = true;

    rec.lang = "en-IN";

    recognitionRef.current = rec;

    rec.onstart = () => {
      if (!speakingRef.current) {
        setAiState("listening");
      }
    };

    rec.onresult = (event: any) => {
      /*
        VERY IMPORTANT:

        Ignore microphone results while the examiner's
        TTS/audio is playing.

        This prevents the examiner's voice from becoming
        the student's answer.
      */
      if (speakingRef.current) {
        return;
      }

      let interim = "";

      let newFinalText = "";

      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {
        const result = event.results[i];

        const transcript =
          result?.[0]?.transcript || "";

        if (result.isFinal) {
          newFinalText += transcript + " ";
        } else {
          interim += transcript;
        }
      }

      /*
        Add finalized speech to the answer buffer.
      */
      if (newFinalText.trim()) {
        answerBufferRef.current =
          `${answerBufferRef.current} ${newFinalText}`
            .replace(/\s+/g, " ")
            .trim();
      }

      /*
        Display the complete answer currently being
        constructed, plus any interim speech.
      */
      const displayText =
        `${answerBufferRef.current} ${interim}`
          .replace(/\s+/g, " ")
          .trim();

      setInterimText(displayText);

      /*
        ANY new speech resets the 5-second timer.

        This is what prevents:
          "The answer is..."

        from immediately being sent while the student
        is still thinking.
      */
      if (
        answerBufferRef.current.trim() ||
        interim.trim()
      ) {
        scheduleAnswerSubmission();
      }
    };

    rec.onerror = (event: any) => {
      /*
        Ignore normal browser recognition interruptions.

        For example:
          no-speech
          aborted
    */
      if (
        event?.error !== "no-speech" &&
        event?.error !== "aborted"
      ) {
        console.warn(
          "Speech recognition error:",
          event?.error
        );
      }
    };

    rec.onend = () => {
      /*
        Chrome can automatically stop SpeechRecognition.

        Restart it while the mic remains enabled.

        Importantly, we DO NOT submit the answer here.
        The silence timer controls submission.
      */
      recognitionRef.current = null;

      if (
        micEnabledRef.current &&
        !endedRef.current
      ) {
        window.setTimeout(() => {
          if (
            micEnabledRef.current &&
            !speakingRef.current &&
            !recognitionRef.current
          ) {
            startRecognition();
          }
        }, 100);
      }
    };

    try {
      rec.start();
    } catch (error) {
      console.warn(
        "Could not start speech recognition:",
        error
      );

      recognitionRef.current = null;
    }
  }, [
    speechSupported,
    scheduleAnswerSubmission,
  ]);

  // ------------------------------------------------------------
  // Stop recognition
  // ------------------------------------------------------------

  const stopRecognition = useCallback(() => {
    clearAnswerTimer();

    answerBufferRef.current = "";

    answerSubmittingRef.current = false;

    setInterimText("");

    const rec = recognitionRef.current;

    if (rec) {
      recognitionRef.current = null;

      rec.onend = null;

      try {
        rec.stop();
      } catch (_) {
        // Browser may already have stopped it.
      }
    }
  }, [clearAnswerTimer]);

  // ------------------------------------------------------------
  // Microphone toggle
  // ------------------------------------------------------------

  const toggleMic = () => {
    const next = !micEnabledRef.current;

    micEnabledRef.current = next;

    setMicEnabled(next);

    if (next) {
      if (!speakingRef.current) {
        setAiState("listening");
      }

      startRecognition();
    } else {
      stopRecognition();

      if (!speakingRef.current) {
        setAiState("idle");
      }
    }
  };

  // ------------------------------------------------------------
  // Incoming WebSocket messages
  // ------------------------------------------------------------

  const handleIncoming = useCallback(
    (msg: any) => {
      if (!msg || !msg.type) return;

      // -----------------------------------------
      // Streaming examiner text
      // -----------------------------------------

      if (msg.type === "question") {
        aiBufferRef.current += msg.text || "";
        return;
      }

      // -----------------------------------------
      // Examiner audio
      // -----------------------------------------

      if (
        msg.type === "audio" &&
        msg.data
      ) {
        pendingAudioRef.current = msg.data;
        return;
      }

      // -----------------------------------------
      // Server status
      // -----------------------------------------

      if (
        msg.type === "status" &&
        msg.state
      ) {
        if (msg.state === "thinking") {
          setAiState("thinking");

          /*
            The answer has reached the server.
            We can reset the submission guard so the
            next student answer can be submitted later.
          */
          answerSubmittingRef.current = false;

          return;
        }

        if (msg.state === "listening") {
          /*
            Backend has finished generating the reply.
          */

          const full =
            aiBufferRef.current.trim();

          const audio =
            pendingAudioRef.current;

          aiBufferRef.current = "";

          pendingAudioRef.current = null;

          if (full) {
            examinerSay(
              full,
              audio ?? undefined
            );
          } else {
            setAiState(
              micEnabledRef.current
                ? "listening"
                : "idle"
            );
          }

          return;
        }
      }

      // -----------------------------------------
      // Session ended
      // -----------------------------------------

      if (msg.type === "end") {
        endedRef.current = true;

        micEnabledRef.current = false;

        setMicEnabled(false);

        stopRecognition();

        if (msg.text) {
          examinerSay(msg.text);
        }

        return;
      }

      // -----------------------------------------
      // Server error
      // -----------------------------------------

      if (msg.type === "error") {
        pushTranscript(
          "ai",
          `⚠️ ${msg.text}`
        );

        answerSubmittingRef.current = false;

        setAiState("idle");
      }
    },
    [
      examinerSay,
      pushTranscript,
      stopRecognition,
    ]
  );

  // ------------------------------------------------------------
  // WebSocket connection
  // ------------------------------------------------------------

  const connectSocket = useCallback(
    (
      cls: string,
      subject: string
    ) => {
      setConnectionStatus("connecting");

      try {
        const ws = new WebSocket(wsUrl);

        socketRef.current = ws;

        ws.onopen = () => {
          setConnectionStatus("connected");

          ws.send(
            JSON.stringify({
              type: "start_session",
              class: cls,
              subject,
            })
          );
        };

        ws.onmessage = (event) => {
          let msg;

          try {
            msg = JSON.parse(event.data);
          } catch (_) {
            msg = {
              type: "question",
              text: String(event.data),
            };
          }

          handleIncoming(msg);
        };

        ws.onerror = () => {
          setConnectionStatus("error");
        };

        ws.onclose = () => {
          if (socketRef.current === ws) {
            setConnectionStatus((current) =>
              current === "error"
                ? current
                : "closed"
            );
          }
        };
      } catch (error) {
        setConnectionStatus("error");
      }
    },
    [wsUrl, handleIncoming]
  );

  // ------------------------------------------------------------
  // Stop all audio
  // ------------------------------------------------------------

  const stopAllAudio = () => {
    audioElRef.current?.pause();

    audioElRef.current = null;

    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.cancel();
    }
  };

  // ------------------------------------------------------------
  // Begin viva
  // ------------------------------------------------------------

  const beginTest = () => {
    if (
      !selectedClass ||
      !selectedSubject
    ) {
      return;
    }

    subjectRef.current = selectedSubject;

    endedRef.current = false;

    speakingRef.current = false;

    micEnabledRef.current = false;

    answerSubmittingRef.current = false;

    answerBufferRef.current = "";

    clearAnswerTimer();

    aiBufferRef.current = "";

    pendingAudioRef.current = null;

    demoIndexRef.current = 0;

    setScreen("session");

    setTranscript([]);

    setElapsed(0);

    setMicEnabled(false);

    setInterimText("");

    startMicVisualizer();

    if (wsUrl.trim()) {
      setAiState("thinking");

      connectSocket(
        selectedClass,
        selectedSubject
      );
    } else {
      setConnectionStatus("demo");

      runDemoTurn();
    }

    timerRef.current =
      window.setInterval(() => {
        setElapsed((seconds) => seconds + 1);
      }, 1000);
  };

  // ------------------------------------------------------------
  // End viva
  // ------------------------------------------------------------

  const endTest = () => {
    endedRef.current = true;

    micEnabledRef.current = false;

    speakingRef.current = false;

    clearAnswerTimer();

    stopRecognition();

    stopMicVisualizer();

    if (socketRef.current) {
      socketRef.current.close();

      socketRef.current = null;
    }

    stopAllAudio();

    if (timerRef.current !== null) {
      clearInterval(timerRef.current);

      timerRef.current = null;
    }

    setMicEnabled(false);

    setAiState("idle");

    setConnectionStatus("idle");

    setScreen("setup");
  };

  // ------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------

  useEffect(() => {
    return () => {
      clearAnswerTimer();

      stopRecognition();

      stopMicVisualizer();

      if (socketRef.current) {
        socketRef.current.close();
      }

      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }

      audioElRef.current?.pause();

      if (
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        window.speechSynthesis.cancel();
      }
    };
  }, [
    clearAnswerTimer,
    stopRecognition,
    stopMicVisualizer,
  ]);

  // ------------------------------------------------------------
  // UI labels
  // ------------------------------------------------------------

  const statusLabel =
    {
      idle: "",
      thinking: "Considering your answer…",
      speaking: "Examiner speaking…",
      listening: "Listening…",
    }[aiState] || "";

  const connectionLabel =
    {
      idle: "",
      connecting: "Connecting to examiner…",
      connected: `Connected to ${wsUrl}`,
      error:
        "Couldn't reach that socket. Check the URL and try again.",
      closed: "Connection closed.",
      demo:
        "Running in demo mode. No socket URL was given, so a local examiner is asking sample questions.",
    }[connectionStatus] || "";

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <div className="viva-root min-h-screen w-full flex items-center justify-center p-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,440;0,9..144,600;1,9..144,500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

        .viva-root {
          --bg: #1F2E28;
          --bg-alt: #253A31;
          --panel: #F5EFE0;
          --panel-ink: #2A2A22;
          --chalk: #ECE7D6;
          --chalk-dim: #A9BBAE;
          --line: #43584B;
          --line-soft: #D9CFAF;
          --brass: #C89B4A;
          --brass-dim: #8F6F38;
          --red: #B3564C;

          background: var(--bg);
          font-family: 'IBM Plex Sans', sans-serif;
          color: var(--chalk);
        }

        .viva-display {
          font-family: 'Fraunces', serif;
        }

        .viva-select-wrap {
          position: relative;
        }

        .viva-select {
          appearance: none;
          -webkit-appearance: none;
          width: 100%;
          background: transparent;
          border: none;
          border-bottom: 1.5px solid var(--line-soft);
          color: var(--panel-ink);
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 1rem;
          padding: 0.55rem 1.75rem 0.55rem 0.1rem;
          outline: none;
          transition: border-color .15s ease;
        }

        .viva-select:focus {
          border-color: var(--brass-dim);
        }

        .viva-select-icon {
          position: absolute;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          pointer-events: none;
          color: var(--brass-dim);
        }

        .viva-input {
          width: 100%;
          background: transparent;
          border: none;
          border-bottom: 1.5px solid var(--line-soft);
          color: var(--panel-ink);
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 0.95rem;
          padding: 0.55rem 0.1rem;
          outline: none;
          transition: border-color .15s ease;
        }

        .viva-input:focus {
          border-color: var(--brass-dim);
        }

        .viva-input::placeholder {
          color: #9C9376;
        }

        .viva-begin-btn {
          font-family: 'IBM Plex Sans', sans-serif;
          font-weight: 600;
          background: var(--brass);
          color: #29200E;
          border: none;
          border-radius: 3px;
          padding: 0.85rem 1.4rem;
          font-size: 0.98rem;
          cursor: pointer;
          transition: background .15s ease, transform .1s ease;
        }

        .viva-begin-btn:hover:not(:disabled) {
          background: #D6A758;
        }

        .viva-begin-btn:active:not(:disabled) {
          transform: scale(0.98);
        }

        .viva-begin-btn:disabled {
          background: #C9BFA0;
          color: #7c7455;
          cursor: not-allowed;
        }

        .viva-orb {
          width: 176px;
          height: 176px;
          border-radius: 50%;
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          background:
            radial-gradient(
              circle at 35% 30%,
              rgba(200,155,74,0.30),
              rgba(200,155,74,0.02) 62%
            ),
            var(--bg-alt);
          border: 1px solid var(--line);
        }

        .viva-orb::before {
          content: '';
          position: absolute;
          inset: -14px;
          border-radius: 50%;
          border: 1px solid var(--brass-dim);
          opacity: 0;
        }

        .viva-orb.is-speaking::before {
          opacity: 0.55;
          animation: viva-pulse 1.7s ease-out infinite;
        }

        @keyframes viva-pulse {
          0% {
            transform: scale(0.92);
            opacity: 0.55;
          }

          100% {
            transform: scale(1.28);
            opacity: 0;
          }
        }

        .viva-orb.is-thinking {
          animation: viva-tilt 1.6s ease-in-out infinite;
        }

        @keyframes viva-tilt {
          0%, 100% {
            opacity: 0.75;
          }

          50% {
            opacity: 1;
          }
        }

        .viva-bars {
          display: flex;
          align-items: center;
          gap: 2.5px;
          height: 48px;
        }

        .viva-bar {
          width: 2.5px;
          border-radius: 2px;
          background: var(--brass);
          transition: height 90ms ease;
        }

        .viva-endbtn {
          background: transparent;
          border: 1px solid var(--red);
          color: var(--red);
          border-radius: 999px;
          padding: 0.5rem 1.05rem;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 0.88rem;
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          cursor: pointer;
          transition: background .15s ease, color .15s ease;
        }

        .viva-endbtn:hover {
          background: var(--red);
          color: var(--bg);
        }

        .viva-mic-btn {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          border: 1.5px solid var(--brass-dim);
          background: var(--bg-alt);
          color: var(--chalk);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background .15s ease, border-color .15s ease;
        }

        .viva-mic-btn.is-on {
          background: var(--brass);
          color: #29200E;
          border-color: var(--brass);
        }

        .viva-line {
          border-color: var(--line);
        }

        .viva-scroll::-webkit-scrollbar {
          width: 6px;
        }

        .viva-scroll::-webkit-scrollbar-thumb {
          background: var(--line);
          border-radius: 3px;
        }
      `}</style>

      {/* ====================================================== */}
      {/* SETUP SCREEN                                           */}
      {/* ====================================================== */}

      {screen === "setup" ? (
        <div className="w-full max-w-md">
          <h1
            className="viva-display text-5xl mb-3"
            style={{ color: "var(--chalk)" }}
          >
            Viva Voice
          </h1>

          <p
            className="text-sm mb-8 max-w-sm"
            style={{ color: "var(--chalk-dim)" }}
          >
            A spoken examination. Choose a class and subject,
            and the examiner will ask questions aloud. Answer
            by speaking, just as in a real viva.
          </p>

          <div
            className="rounded-sm p-7"
            style={{
              background: "var(--panel)",
              border: "1px solid var(--line-soft)",
            }}
          >
            {/* Class */}

            <div className="mb-5">
              <label
                className="block text-xs mb-1"
                style={{ color: "#6B6449" }}
              >
                Class
              </label>

              <div className="viva-select-wrap">
                <select
                  className="viva-select"
                  value={selectedClass}
                  onChange={(e) =>
                    setSelectedClass(e.target.value)
                  }
                >
                  <option value="">
                    Select class
                  </option>

                  {CLASS_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      Class {c}
                    </option>
                  ))}
                </select>

                <ChevronDown
                  size={16}
                  className="viva-select-icon"
                />
              </div>
            </div>

            {/* Subject */}

            <div className="mb-5">
              <label
                className="block text-xs mb-1"
                style={{ color: "#6B6449" }}
              >
                Subject
              </label>

              <div className="viva-select-wrap">
                <select
                  className="viva-select"
                  value={selectedSubject}
                  onChange={(e) =>
                    setSelectedSubject(e.target.value)
                  }
                >
                  <option value="">
                    Select subject
                  </option>

                  {SUBJECT_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>

                <ChevronDown
                  size={16}
                  className="viva-select-icon"
                />
              </div>
            </div>

            {/* WebSocket */}

            <div className="mb-6">
              <label
                className="block text-xs mb-1"
                style={{ color: "#6B6449" }}
              >
                AI examiner socket (optional)
              </label>

              <input
                className="viva-input"
                type="text"
                placeholder="ws://localhost:8000/ws"
                value={wsUrl}
                onChange={(e) =>
                  setWsUrl(e.target.value)
                }
              />
            </div>

            <button
              className="viva-begin-btn w-full"
              disabled={
                !selectedClass ||
                !selectedSubject
              }
              onClick={beginTest}
            >
              Begin Viva
            </button>
          </div>

          {!speechSupported && (
            <p
              className="text-xs mt-4 flex items-start gap-1.5"
              style={{
                color: "var(--chalk-dim)",
              }}
            >
              <AlertCircle
                size={14}
                className="mt-0.5 shrink-0"
              />

              Your browser doesn't support live speech
              recognition, so you'll type answers instead.
              Chrome gives the full spoken experience.
            </p>
          )}
        </div>
      ) : (
        /* ==================================================== */
        /* SESSION SCREEN                                       */
        /* ==================================================== */

        <div
          className="w-full max-w-lg flex flex-col"
          style={{
            height: "min(88vh, 780px)",
          }}
        >
          {/* Header */}

          <div className="flex items-center justify-between pb-4 mb-5 border-b viva-line">
            <div>
              <p
                className="text-sm"
                style={{
                  color: "var(--chalk-dim)",
                }}
              >
                Class {selectedClass} ·{" "}
                {selectedSubject}
              </p>

              {connectionLabel && (
                <p
                  className="text-xs mt-0.5"
                  style={{
                    color:
                      connectionStatus === "error"
                        ? "var(--red)"
                        : "var(--chalk-dim)",
                  }}
                >
                  {connectionLabel}
                </p>
              )}
            </div>

            <div className="flex items-center gap-4">
              <span
                className="viva-display text-lg"
                style={{
                  color: "var(--chalk-dim)",
                }}
              >
                {formatTime(elapsed)}
              </span>

              <button
                className="viva-endbtn"
                onClick={endTest}
              >
                <PhoneOff size={14} />
                End viva
              </button>
            </div>
          </div>

          {/* Examiner orb */}

          <div className="flex flex-col items-center py-6">
            <div
              className={`viva-orb ${
                aiState === "speaking"
                  ? "is-speaking"
                  : ""
              } ${
                aiState === "thinking"
                  ? "is-thinking"
                  : ""
              }`}
            >
              {aiState === "thinking" ? (
                <Loader2
                  size={30}
                  className="animate-spin"
                  style={{
                    color: "var(--brass)",
                  }}
                />
              ) : aiState === "listening" ? (
                <div className="viva-bars">
                  {bars.map((height, index) => (
                    <div
                      key={index}
                      className="viva-bar"
                      style={{
                        height: `${height}px`,
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background:
                      "var(--brass-dim)",
                  }}
                />
              )}
            </div>

            <p
              className="text-xs mt-4 tracking-wide"
              style={{
                color: "var(--chalk-dim)",
              }}
            >
              {statusLabel}
            </p>

            {/* Microphone error */}

            {micError && (
              <p
                className="text-xs mt-3 max-w-xs text-center flex items-center gap-1.5"
                style={{
                  color: "var(--red)",
                }}
              >
                <AlertCircle
                  size={13}
                  className="shrink-0"
                />

                {micError}
              </p>
            )}

            {/* Microphone button */}

            <button
              className={`viva-mic-btn mt-6 ${
                micEnabled ? "is-on" : ""
              }`}
              onClick={toggleMic}
              aria-label={
                micEnabled
                  ? "Mute microphone"
                  : "Unmute microphone"
              }
              disabled={!speechSupported}
              title={
                !speechSupported
                  ? "Speech recognition isn't supported in this browser"
                  : ""
              }
            >
              {micEnabled ? (
                <Mic size={22} />
              ) : (
                <MicOff size={22} />
              )}
            </button>

            {/* Helpful silence indicator */}

            {micEnabled &&
              !speakingRef.current &&
              answerBufferRef.current && (
                <p
                  className="text-[11px] mt-3"
                  style={{
                    color: "var(--chalk-dim)",
                  }}
                >
                  Listening for your answer…
                </p>
              )}
          </div>

          {/* Transcript */}

          <div
            className="viva-scroll flex-1 overflow-y-auto rounded-sm p-4 mt-2"
            style={{
              background: "var(--bg-alt)",
              border: "1px solid var(--line)",
            }}
          >
            {transcript.length === 0 && (
              <p
                className="text-xs"
                style={{
                  color: "var(--chalk-dim)",
                }}
              >
                The examiner will begin shortly.
              </p>
            )}

            {transcript.map((entry) => (
              <div
                key={entry.id}
                className="mb-3"
              >
                <p
                  className="text-xs mb-0.5"
                  style={{
                    color:
                      entry.speaker === "ai"
                        ? "var(--brass)"
                        : "var(--chalk-dim)",
                  }}
                >
                  {entry.speaker === "ai"
                    ? "Examiner"
                    : "You"}
                </p>

                <p className="text-sm leading-relaxed">
                  {entry.text}
                </p>
              </div>
            ))}

            {interimText && (
              <p
                className="text-sm italic"
                style={{
                  color: "var(--chalk-dim)",
                }}
              >
                {interimText}
              </p>
            )}

            <div ref={transcriptEndRef} />
          </div>

          {/* Manual input fallback */}

          {!speechSupported && (
            <div className="flex gap-2 mt-3">
              <input
                className="viva-input flex-1"
                style={{
                  color: "var(--chalk)",
                  borderColor: "var(--line)",
                }}
                placeholder="Type your answer…"
                value={manualText}
                onChange={(e) =>
                  setManualText(e.target.value)
                }
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    manualText.trim()
                  ) {
                    sendAnswer(manualText);

                    setManualText("");
                  }
                }}
              />

              <button
                className="viva-begin-btn"
                onClick={() => {
                  if (manualText.trim()) {
                    sendAnswer(manualText);

                    setManualText("");
                  }
                }}
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
