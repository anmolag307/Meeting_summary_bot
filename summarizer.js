require('dotenv').config();
const fs = require('fs');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const DEFAULT_SUMMARY_LANGUAGE = process.env.SUMMARY_LANGUAGE || 'English';

function extractTranscriptData(transcription) {
    if (!transcription) {
        return { text: '', language: 'unknown', segments: [] };
    }

    if (typeof transcription === 'string') {
        return { text: transcription, language: 'unknown', segments: [] };
    }

    return {
        text: transcription.text || '',
        language: transcription.language || 'unknown',
        segments: Array.isArray(transcription.segments) ? transcription.segments : [],
    };
}

function safeJsonParse(raw) {
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        const trimmed = String(raw).trim();
        const match = trimmed.match(/\{[\s\S]*\}$/);
        if (!match) return null;

        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

async function runGroqSummarizer(audioFilePath) {
    console.log(`\n Reading audio file: ${audioFilePath}`);
    
    if (!fs.existsSync(audioFilePath)) {
        console.error(" Audio file not found. Make sure the bot saved it!");
        throw new Error("Audio file not found");
    }

    // ==========================================
    // 1. TRANSCRIBE WITH GROQ WHISPER
    // ==========================================
    console.log(" Sending to Groq Whisper-large-v3 for transcription...");
    let transcriptText = "";
    let detectedPrimaryLanguage = 'unknown';
    let transcriptSegments = [];
    
    try {
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(audioFilePath),
            model: "whisper-large-v3",
            response_format: "verbose_json",
            temperature: 0,
        });

        const parsedTranscription = extractTranscriptData(transcription);
        transcriptText = parsedTranscription.text;
        detectedPrimaryLanguage = parsedTranscription.language;
        transcriptSegments = parsedTranscription.segments;
    } catch (err) {
        console.error(" Groq Whisper Error:", err.message);
        throw err; // INTEGRATION CHANGE: Throw error to server.js
    }

    // Basic cleanup just in case Whisper adds weird whitespace
    transcriptText = transcriptText.trim();

    if (!transcriptText || transcriptText === "") {
        console.log(" No speech detected in the audio file.");
        throw new Error("No speech detected");
    }

    console.log("\n--- RAW TRANSCRIPT PREVIEW ---");
    console.log(transcriptText.substring(0, 500) + "...\n------------------------------\n");
    console.log(` Whisper detected primary language: ${detectedPrimaryLanguage}`);

    // ==========================================
    // 2. SUMMARIZE WITH GROQ LLAMA-3.3-70B
    // ==========================================
    console.log(` Feeding transcript to Llama-3.3-70b for JSON summary in ${DEFAULT_SUMMARY_LANGUAGE}...`);
    try {
        const chatCompletion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" }, 
            messages: [
                {
                    role: "system",
                    content: `You are a highly intelligent executive assistant.
Analyze the raw meeting transcript, which may contain multiple languages and code-switching.
Speaker names are not provided. Use phrases like "One participant mentioned" or "It was agreed upon".

Rules for the Summary:
1) Write the ENTIRE JSON response strictly in ${DEFAULT_SUMMARY_LANGUAGE}. Translate all foreign dialogue into clear, professional ${DEFAULT_SUMMARY_LANGUAGE}.
2) Provide a highly detailed summary that captures the nuance of the conversation.
3) If a specific foreign-language idiom, cultural reference, or project name is used, you may include it in its original language in parentheses next to the translation.
4) Detect all major languages used in the transcript and list them.
5) Completely ignore any random isolated words at the very beginning of the transcript if they do not make sense in the context of the meeting.

Return a JSON object with this EXACT structure:
{
    "title": "A precise, professional title for the meeting",
    "overview": "A comprehensive paragraph summarizing the core purpose and main outcome of the meeting",
    "key_decisions": [
        "A clear statement of a decision made during the meeting"
    ],
    "timeline": [ 
        { "topic": "Brief topic name", "details": "Detailed explanation of what was discussed, debated, or shared regarding this topic" } 
    ],
    "action_items": [ 
        { "task": "Specific task description", "owner": "Role/Name if mentioned, otherwise 'Unassigned'" } 
    ],
    "languages_detected": ["Language 1", "Language 2"]
}`
                },
                {
                    role: "user",
                    content: `Transcription metadata:\n${JSON.stringify({
                        detected_primary_language: detectedPrimaryLanguage,
                        segment_count: transcriptSegments.length,
                    }, null, 2)}\n\nTranscript:\n${transcriptText}`
                }
            ]
        });

        const rawSummary = chatCompletion.choices[0]?.message?.content;
        const parsedSummary = safeJsonParse(rawSummary);

        if (!parsedSummary) {
            console.error("Could not parse model output as JSON.");
            throw new Error("Failed to parse JSON summary");
        }

        parsedSummary.primary_language = detectedPrimaryLanguage || 'unknown';
        
        // Save the final intelligence file locally as backup
        const summaryPath = audioFilePath.replace('.webm', '_summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(parsedSummary, null, 2), 'utf8');

        console.log(`\n SUCCESS! Summary saved to: ${summaryPath}`);
        
        // INTEGRATION CHANGE: Return the parsed summary to server.js
        return parsedSummary;

    } catch (err) {
        console.error(" Groq Llama Error:", err.message);
        throw err; // INTEGRATION CHANGE: Throw error to server.js
    }
}

module.exports = { runGroqSummarizer };

// UNCOMMENT THE LINES BELOW TO TEST THIS FILE MANUALLY
// if (require.main === module) {
//     const testAudio = './recording.webm';
//     runGroqSummarizer(testAudio).catch(console.error);
// }
