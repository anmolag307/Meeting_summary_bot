const form = document.getElementById('meetingForm');
const meetUrlInput = document.getElementById('meetUrl');
const startBtn = document.getElementById('startBtn');
const statusCard = document.getElementById('statusCard');
const statusText = document.getElementById('statusText');
const statusHint = document.getElementById('statusHint');
const meetingIdLabel = document.getElementById('meetingId');
const errorBox = document.getElementById('errorBox');
const downloadsWrap = document.getElementById('downloads');
const transcriptLink = document.getElementById('transcriptLink');
const summaryLink = document.getElementById('summaryLink');

// In production (e.g., Vercel), /api/* is rewritten to your backend.
const API_BASE = window.location.hostname === 'localhost' ? '' : '/api';

const statusCopy = {
  JOINING: 'Bot is joining your meeting...',
  RECORDING: 'Recording in progress',
  SUMMARIZING: 'Meeting ended. Generating transcript and summary...',
  COMPLETED: 'Completed successfully',
  FAILED: 'Process failed',
};

let pollId = null;
let activeMeeting = null;

function setError(message) {
  if (!message) {
    errorBox.classList.add('hidden');
    errorBox.textContent = '';
    return;
  }

  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function updateStatus(meeting) {
  statusCard.classList.remove('hidden');
  meetingIdLabel.textContent = `Meeting ID: ${meeting.id}`;
  statusText.textContent = statusCopy[meeting.status] || meeting.status;

  if (meeting.status === 'JOINING') {
    statusHint.textContent = 'The browser bot is being launched and admitted to the call.';
  } else if (meeting.status === 'RECORDING') {
    statusHint.textContent = 'Keep the meeting running. Processing starts after the meeting ends.';
  } else if (meeting.status === 'SUMMARIZING') {
    statusHint.textContent = 'This can take a few minutes depending on meeting length.';
  } else if (meeting.status === 'COMPLETED') {
    statusHint.textContent = 'Use the buttons below to download your files.';
  } else if (meeting.status === 'FAILED') {
    statusHint.textContent = 'Check server logs to diagnose the failure.';
  }
}

function updateDownloads(meeting) {
  const transcriptUrl = meeting?.downloads?.transcript;
  const summaryUrl = meeting?.downloads?.summary;

  if (!transcriptUrl || !summaryUrl) {
    downloadsWrap.classList.add('hidden');
    return;
  }

  transcriptLink.href = transcriptUrl;
  summaryLink.href = summaryUrl;
  downloadsWrap.classList.remove('hidden');
}

async function fetchMeeting(meetingId) {
  if (!activeMeeting?.token) {
    throw new Error('Missing meeting token. Please start the meeting again.');
  }

  const response = await fetch(`${API_BASE}/meetings/${meetingId}?token=${encodeURIComponent(activeMeeting.token)}`);
  if (!response.ok) {
    throw new Error('Could not fetch meeting status.');
  }
  return response.json();
}

function cleanupActiveMeeting() {
  if (!activeMeeting?.id || !activeMeeting?.token) return;

  const url = `${API_BASE}/meetings/${activeMeeting.id}/cleanup?token=${encodeURIComponent(activeMeeting.token)}`;
  const payload = new Blob([JSON.stringify({ reason: 'client_closed' })], {
    type: 'application/json',
  });

  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, payload);
  }
}

window.addEventListener('beforeunload', cleanupActiveMeeting);
window.addEventListener('pagehide', cleanupActiveMeeting);

function stopPolling() {
  if (pollId) {
    window.clearInterval(pollId);
    pollId = null;
  }
}

function startPolling(meetingId) {
  stopPolling();

  pollId = window.setInterval(async () => {
    try {
      const meeting = await fetchMeeting(meetingId);
      updateStatus(meeting);
      updateDownloads(meeting);

      if (meeting.status === 'COMPLETED' || meeting.status === 'FAILED') {
        stopPolling();
        startBtn.disabled = false;
      }
    } catch (error) {
      stopPolling();
      setError(error.message || 'Unexpected polling error.');
      startBtn.disabled = false;
    }
  }, 4000);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('');
  downloadsWrap.classList.add('hidden');

  const meetUrl = meetUrlInput.value.trim();
  if (!meetUrl) {
    setError('Please enter a Google Meet link.');
    return;
  }

  startBtn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/meetings/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetUrl }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Could not start meeting bot.');
    }

    activeMeeting = {
      id: payload.meetingId,
      token: payload.token,
    };

    const meeting = await fetchMeeting(payload.meetingId);
    updateStatus(meeting);
    updateDownloads(meeting);
    startPolling(payload.meetingId);
  } catch (error) {
    setError(error.message || 'Unexpected error while starting meeting.');
    startBtn.disabled = false;
  }
});
