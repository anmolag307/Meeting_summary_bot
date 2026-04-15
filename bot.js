const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// Keep Node's event loop alive so async SIGINT handler
// has time to run before the process exits
process.stdin.resume();

// ==========================================
// INTEGRATION CHANGES: Parse Arguments & Setup Folders
// ==========================================
const args = process.argv.slice(2);
const MEET_URL = args[0] || "https://meet.google.com/hdr-nmbs-ngz";
const MEETING_ID = args[1] || "manual-run";

const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir);
}

const BOT_NAME = "Summary Bot";
const ALONE_THRESHOLD_SECONDS = 10;
const CHECK_INTERVAL_MS = 5000; 

async function startAudioBot(meetUrl) {
  console.log(`🚀 Launching browser for meeting: ${MEETING_ID}...`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    userDataDir: "./bot-chrome-profile",
    defaultViewport: null,          
    args: [
      "--start-maximized",          
      "--use-fake-ui-for-media-stream",
      '--use-fake-device-for-media-stream',
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // ==========================================
  // INJECT AUDIO INTERCEPTOR
  // ==========================================
  await page.evaluateOnNewDocument(() => {
    const OriginalRTC = window.RTCPeerConnection;
    let audioContext = null;
    let destination = null;

    function getOrCreateContext() {
      if (!audioContext) {
        audioContext = new AudioContext();
        destination = audioContext.createMediaStreamDestination();
        window.__captureStream = destination.stream;
      }
      return { audioContext, destination };
    }

    window.RTCPeerConnection = function (...args) {
      const pc = new OriginalRTC(...args);
      pc.addEventListener("track", (event) => {
        if (event.track.kind !== "audio") return;
        const { audioContext, destination } = getOrCreateContext();
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(destination);
        console.log("[Interceptor] Remote audio track connected.");
      });
      return pc;
    };
    Object.assign(window.RTCPeerConnection, OriginalRTC);
  });

  // ==========================================
  // NAVIGATE TO MEET
  // ==========================================
  console.log(`🔗 Going to ${meetUrl}...`);
  await page.goto(meetUrl, { waitUntil: "networkidle2" });

  console.log("⏳ Waiting 1s for pre-join screen to load...");
  await delay(1000);

  // ==========================================
  // SMART AUTH DETECTION
  // ==========================================
  const state = await detectPageState(page);
  console.log(`📋 Page state: ${state}`);

  if (state === "guest") {
    console.log(`⌨️  Entering guest name: "${BOT_NAME}"...`);
    try {
      const nameInput = await page.waitForSelector(
        'input[placeholder*="name" i], input[aria-label*="name" i], input[type="text"]',
        { timeout: 4000 }
      );
      await nameInput.click({ clickCount: 3 });
      await nameInput.type(BOT_NAME, { delay: 80 });
      console.log("✅ Name entered.");
    } catch {
      console.warn("⚠️  Could not find name input.");
    }

  } else if (state === "loggedin") {
    console.log("✅ Already logged in — joining directly.");

  } else {
    console.log("\n=============================================");
    console.log("🔐 LOGIN REQUIRED — Log in within 90 seconds.");
    console.log("=============================================\n");

    let loginSuccessful = false;
    for (let remaining = 90; remaining > 0; remaining -= 2) {
      await delay(2000); // Check every 2 seconds
      
      const currentUrl = page.url();
      // If we are back on the meet page and not on the Google Accounts sign-in page
      if (currentUrl.includes("meet.google.com") && !currentUrl.includes("accounts.google.com")) {
          console.log("✅ Login successful! Skipping wait time...");
          loginSuccessful = true;
          break;
      }
      
      if (remaining % 10 === 0) { // Just to keep the terminal updated without spamming
          console.log(`⏳ ~${remaining}s remaining...`);
      }
    }

    if (!loginSuccessful) {
        console.log("⌛ Time's up — continuing...");
        if (!page.url().includes("meet.google.com")) {
          console.log("🔄 Navigating back to the meeting...");
          await page.goto(meetUrl, { waitUntil: "networkidle2" });
          await delay(2000);
        }
    }
  }

  // ==========================================
  // MUTE MIC & CAMERA (PRE-JOIN)
  // ==========================================
  console.log("⏳ Waiting 1s before muting...");
  await muteControls(page);
  await delay(1000);

  await dismissGotItPopup(page);

  // ==========================================
  // CLICK JOIN
  // ==========================================
  console.log("🖱️  Clicking join button...");

  const joinXPaths =
    state === "guest"
      ? [
          '::-p-xpath(//span[text()="Ask to join"]/ancestor::button)',
          '::-p-xpath(//span[text()="Join now"]/ancestor::button)',
        ]
      : [
          '::-p-xpath(//span[text()="Join now"]/ancestor::button)',
          '::-p-xpath(//span[text()="Ask to join"]/ancestor::button)',
        ];

  let joined = false;
  for (const sel of joinXPaths) {
    try {
      console.log(`  Trying: ${sel}`);
      const btn = await page.waitForSelector(sel, { timeout: 3000 });
      await delay(500);

      const box = await btn.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await delay(100);
        await page.mouse.down();
        await delay(80);
        await page.mouse.up();
      } else {
        await page.evaluate((el) => {
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent("click",     { bubbles: true, cancelable: true }));
        }, btn);
      }

      joined = true;
      break;
    } catch { continue; }
  }

  if (!joined) {
    console.error("❌ Could not find join button. Keeping window open for 5 min to debug.");
    await delay(300000);
    process.exit(1);
  }

  console.log("⏳ Waiting to be admitted (up to 2 min)...");
  try {
    await page.waitForSelector('[aria-label="Leave call"]', { timeout: 120000 });
  } catch {
    console.error("❌ Not admitted. Host may need to click 'Admit'.");
    process.exit(1);
  }
  console.log("✅ In the meeting!");

  // ==========================================
  // ENFORCE MUTE POST-JOIN
  // ==========================================
  console.log("🛡️ Enforcing mute state inside the meeting...");
  await delay(1500); 
  await muteControls(page);

  // ==========================================
  // START RECORDING
  // ==========================================
  try {
    await page.bringToFront();
    await page.mouse.click(10, 10); 
  } catch (e) {} 
  await delay(1000);

  // INTEGRATION CHANGE: Save to recordings directory
  const filePath = path.join(recordingsDir, `recording_${Date.now()}.webm`);
  const fileStream = fs.createWriteStream(filePath);
  let bytesWritten = 0;
  let hasData = false;

  await page.exposeFunction("__audioChunk", (base64chunk) => {
    const buf = Buffer.from(base64chunk, "base64");
    fileStream.write(buf);
    bytesWritten += buf.length;
    if (!hasData) {
      hasData = true;
      console.log(`🟢 Audio flowing! First chunk: ${buf.length} bytes`);
    }
  });

  async function startRecorder() {
    try {
      return await page.evaluate(() => {
        const stream = window.__captureStream;
        if (!stream || stream.getAudioTracks().length === 0) return false;

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128000 });
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            const reader = new FileReader();
            reader.onload = () => window.__audioChunk(reader.result.split(",")[1]);
            reader.readAsDataURL(e.data);
          }
        };
        recorder.onerror = (e) => console.error("[Recorder] Error:", e.error);
        recorder.start(1000);
        window.__mediaRecorder = recorder;
        return true;
      });
    } catch (e) { return false; }
  }

  let recorderStarted = await startRecorder();
  if (!recorderStarted) {
    console.log("⏳ No audio tracks yet — retrying in 5s...");
    await delay(2500);
    recorderStarted = await startRecorder();
    if (!recorderStarted) console.warn("⚠️  Still no tracks. Will capture when others speak.");
  }

  console.log(`🔴 RECORDING → ${filePath}`);
  console.log("Press [Ctrl+C] to stop manually.\n");

  // INTEGRATION CHANGE: Notify Express that we are officially recording
  if (process.send) {
      process.send({ status: 'RECORDING' });
  }

  setTimeout(() => {
    if (!hasData) console.warn("⚠️  No audio after 20s. Is anyone else in the call?");
    else console.log(`📊 ${(bytesWritten / 1024).toFixed(1)} KB recorded so far.`);
  }, 20000);

  // ==========================================
  // BULLETPROOF "GHOST" SHUTDOWN
  // ==========================================
  let isShuttingDown = false;

  const shutdown = async (reason) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Shutting down — ${reason}`);

    try {
      // Only try to manipulate the page if the browser is actually still alive!
      if (browser.isConnected() && !page.isClosed()) {
          try {
            await page.bringToFront();
            await delay(300);
          } catch { } 

          await page.evaluate(() => {
            if (window.__mediaRecorder?.state !== "inactive")
              window.__mediaRecorder?.stop();
          }).catch(() => {});

          await delay(800);

          try {
            console.log("📴 Leaving the call by navigating away...");
            await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5000 });
            console.log("✅ Left the call — WebRTC connections dropped.");
          } catch (e) {
            console.log("ℹ️  Navigate away skipped.");
          }
      } else {
          console.log("📴 Browser already closed, skipping UI shutdown steps...");
      }

      // CRITICAL: We MUST close the file stream regardless of how it shut down
      await new Promise((resolve, reject) =>
        fileStream.end((err) => (err ? reject(err) : resolve()))
      );

      console.log(`✅ Saved: ${filePath} (${(bytesWritten / 1024).toFixed(1)} KB)`);
      
      if (browser.isConnected()) {
          await browser.close().catch(() => {});
      }
      
      process.stdin.pause(); 

      // INTEGRATION CHANGE: Notify Express that audio is finished and ready for summary
      if (process.send) {
          process.send({ 
              status: 'FINISHED_AUDIO', 
              audioPath: filePath 
          });
      }

      process.exit(0);
    } catch (err) {
      console.error("Shutdown error:", err.message);
      process.stdin.pause();
      process.exit(1);
    }
  };

  process.on("SIGINT", async () => {
    process.on("SIGINT", () => {
      console.log("\n⚠️  Force quitting...");
      process.exit(1);
    });
    await shutdown("Ctrl+C");
  });

  browser.on('disconnected', () => {
      shutdown("Browser window was closed manually via 'X' button.");
  });

  // ==========================================
  // MANUAL LEAVE / HANG UP DETECTOR
  // ==========================================
  console.log("🛡️ Monitoring for manual hang-ups or meeting end...");
  const hangupMonitor = setInterval(async () => {
    if (isShuttingDown) {
        clearInterval(hangupMonitor);
        return;
    }
    try {
        const currentUrl = page.url();
        if (currentUrl === "https://meet.google.com/" || currentUrl.includes("landing")) {
            clearInterval(hangupMonitor);
            shutdown("Bot navigated away from the meeting.");
            return;
        }

        const isCallEnded = await page.evaluate(() => {
            const text = document.body.innerText;
            return text.includes("You left the meeting") || 
                   text.includes("You've been removed") || 
                   text.includes("Return to home screen") ||
                   text.includes("Call ended");
        });

        if (isCallEnded) {
            clearInterval(hangupMonitor);
            shutdown("Meeting ended or bot hung up.");
        }
    } catch (e) {
         if (e.message.includes("Target closed") || e.message.includes("Session closed")) {
             clearInterval(hangupMonitor);
             shutdown("Browser window was closed manually by user.");
         }
    }
  }, 2000);

  // ==========================================
  // SPEEDY AUTO-LEAVE MONITOR
  // ==========================================
  console.log("👀 Monitoring participant count...");
  let aloneCount = 0;
  const maxAlone = Math.ceil(ALONE_THRESHOLD_SECONDS / (CHECK_INTERVAL_MS / 1000));

  const monitor = setInterval(async () => {
    if (isShuttingDown) { clearInterval(monitor); return; }
    try {
      const count = await getParticipantCount(page);
      
      if (count !== -1) {
        console.log(`👥 Participants: ${count}`);
      }

      if (count <= 1 && count !== -1) {
        aloneCount++;
        const secsLeft = (maxAlone - aloneCount) * (CHECK_INTERVAL_MS / 1000);
        console.log(`👻 Alone ${aloneCount}/${maxAlone} — leaving in ~${secsLeft}s`);
        if (aloneCount >= maxAlone) { clearInterval(monitor); shutdown("Empty room"); }
      } else {
        if (aloneCount > 0) console.log("👥 Others present — resetting timer.");
        aloneCount = 0;
      }
    } catch { }
  }, CHECK_INTERVAL_MS);
}

// ==========================================
// HELPERS
// ==========================================

async function detectPageState(page) {
  return page.evaluate(() => {
    if (
      window.location.href.includes("accounts.google.com") ||
      window.location.href.includes("signin") ||
      (document.querySelector('input[type="email"]') &&
        document.body.innerText.includes("Google"))
    ) return "loginwall";

    if (
      document.querySelector('input[placeholder*="name" i]') ||
      document.querySelector('input[aria-label*="name" i]')
    ) return "guest";

    return "loggedin";
  });
}

async function getParticipantCount(page) {
  return page.evaluate(() => {
    const peopleBtn = document.querySelector('[aria-label*="People"], [data-tooltip*="people" i]');
    if (peopleBtn) {
      const m = (peopleBtn.getAttribute("aria-label") || peopleBtn.innerText || "").match(/\d+/);
      if (m) return parseInt(m[0]);
    }
    const tiles = document.querySelectorAll('[data-requested-participant-id], [data-participant-id]');
    if (tiles.length > 0) return tiles.length;
    const body = document.body.innerText;
    if (body.includes("only one here") || body.includes("Waiting for others")) return 1;
    return -1; 
  }).catch(() => { return -1; });
}

async function muteControls(page) {
  const micTurnOffSelectors = [
    '[aria-label*="Turn off microphone" i]'
  ];
  const camTurnOffSelectors = [
    '[aria-label*="Turn off camera" i]'
  ];

  let micActivelyMuted = false;
  for (const sel of micTurnOffSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await delay(400);
        console.log(`🔇 Mic turned off via UI.`);
        micActivelyMuted = true;
        break;
      }
    } catch { }
  }

  let camActivelyMuted = false;
  for (const sel of camTurnOffSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await delay(400);
        console.log(`📷 Camera turned off via UI.`);
        camActivelyMuted = true;
        break;
      }
    } catch { }
  }

  if (!micActivelyMuted) console.log("🔇 Mic appears to already be off.");
  if (!camActivelyMuted) console.log("📷 Camera appears to already be off.");
}

async function dismissGotItPopup(page) {
  const gotItSelectors = [
    '::-p-xpath(//span[text()="Got it"]/ancestor::button)',
    '::-p-xpath(//span[contains(text(),"Got it")]/ancestor::button)',
    '[data-mdc-dialog-action="ok"]',
    '::-p-xpath(//button[.//span[contains(translate(text(),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"got it")]])',
  ];

  for (const sel of gotItSelectors) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 3000 });
      if (btn) {
        const box = await btn.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await delay(100);
          await page.mouse.down();
          await delay(80);
          await page.mouse.up();
        } else {
          await page.evaluate((el) => el.click(), btn);
        }
        console.log("✅ Dismissed 'Got it' popup.");
        await delay(500); 
        return;
      }
    } catch { }
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

startAudioBot(MEET_URL);