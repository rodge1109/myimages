 // server.js - COMPLETE WORKING VERSION
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const request = require('request');

const app = express();
app.use(bodyParser.json());

/* =======================
   GOOGLE SHEETS SETUP
======================= */

let sheets;

try {
  const credentials = process.env.GOOGLE_CREDENTIALS_BASE64
    ? JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString())
    : require('./credentials.json');

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });

  sheets = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets auth initialized');
} catch (err) {
  console.error('❌ Google Sheets auth failed:', err.message);
}

/* =======================
   HEALTH CHECK
======================= */

app.get('/health', async (req, res) => {
  if (!sheets) {
    return res.status(500).json({
      status: 'ERROR',
      sheets: false,
      message: 'Google Sheets not initialized'
    });
  }

  try {
    await sheets.spreadsheets.get({
      spreadsheetId: process.env.SHEET_ID,
    });
    res.json({ status: 'OK', sheets: true });
  } catch (err) {
    res.status(500).json({
      status: 'ERROR',
      sheets: false,
      error: err.message
    });
  }
});

/* =======================
   WEBHOOK SUBSCRIPTION TOOLS
======================= */

app.get('/subscribe-feed', async (req, res) => {
  try {
    const configRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:D',
    });

    const rows = configRes.data.values || [];
    const results = [];

    for (const row of rows.slice(1)) {
      if (!row[0] || !row[1]) continue;
      
      const pageId = row[0];
      const pageToken = row[1];
      
      console.log(`\nProcessing Page ID: ${pageId}`);
      
      const subscribe = await new Promise((resolve) => {
        request.post({
          url: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v21.0'}/${pageId}/subscribed_apps`,
          qs: { 
            access_token: pageToken,
            subscribed_fields: 'feed,messages,messaging_postbacks,message_reads,message_deliveries'
          },
          json: true
        }, (err, response, body) => {
          resolve({ error: err || body.error, success: body.success });
        });
      });
      
      const verify = await new Promise((resolve) => {
        request.get({
          url: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v21.0'}/${pageId}/subscribed_apps`,
          qs: { access_token: pageToken },
          json: true
        }, (err, response, body) => {
          resolve(body);
        });
      });
      
      const feedSubscribed = verify.data && 
                            verify.data[0] && 
                            verify.data[0].subscribed_fields && 
                            verify.data[0].subscribed_fields.includes('feed');
      
      results.push({
        pageId,
        feedSubscribed,
        status: feedSubscribed ? '✅ SUCCESS' : '❌ FAILED',
        fields: verify.data?.[0]?.subscribed_fields || []
      });
      
      console.log(`${feedSubscribed ? '✅' : '❌'} Page ${pageId}`);
    }

    const html = `
<!DOCTYPE html>
<html><head><title>Feed Subscription Results</title>
<style>
  body{font-family:Arial;max-width:1200px;margin:50px auto;padding:20px;background:#f5f5f5}
  .container{background:#fff;padding:30px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
  h1{color:#1877f2;border-bottom:3px solid #1877f2;padding-bottom:10px}
  .result{padding:20px;margin:20px 0;border-radius:5px;border-left:5px solid #1877f2}
  .success{border-left-color:#28a745;background:#d4edda}
  .failed{border-left-color:#dc3545;background:#f8d7da}
  .status{font-size:24px;font-weight:bold;margin-bottom:10px}
  code{background:#e9ecef;padding:2px 6px;border-radius:3px}
</style></head><body>
<div class="container"><h1>📡 Feed Subscription Results</h1>
${results.map(r => `
  <div class="result ${r.feedSubscribed ? 'success' : 'failed'}">
    <div class="status">${r.status}</div>
    <p><strong>Page ID:</strong> ${r.pageId}</p>
    <p><strong>Subscribed Fields:</strong> ${r.fields.join(', ')}</p>
    ${r.feedSubscribed ? 
      '<p style="color:#28a745">✅ Comments will now trigger webhooks!</p>' : 
      '<p style="color:#dc3545">❌ Token may be expired. Generate new token.</p>'}
  </div>
`).join('')}
<div style="background:#fff3cd;padding:20px;border-radius:5px;margin-top:30px">
  <h2>🧪 Test Now</h2>
  <ol>
    <li>Go to your Facebook Page</li>
    <li>Make a new post</li>
    <li>Comment on that post</li>
    <li>Check server logs for: <code>📝 New comment</code></li>
    <li>You should receive a DM!</li>
  </ol>
</div></div></body></html>`;

    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/check-subscriptions', async (req, res) => {
  try {
    const configRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:D',
    });

    const rows = configRes.data.values || [];
    const results = [];

    for (const row of rows.slice(1)) {
      if (!row[0] || !row[1]) continue;
      
      const pageId = row[0];
      const pageToken = row[1];
      
      const subscriptions = await new Promise((resolve) => {
        request.get({
          url: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v21.0'}/${pageId}/subscribed_apps`,
          qs: { access_token: pageToken },
          json: true
        }, (err, response, body) => {
          resolve(body);
        });
      });
      
      results.push({
        pageId,
        subscriptions: subscriptions.data || [],
        hasFeed: subscriptions.data?.[0]?.subscribed_fields?.includes('feed') || false,
        error: subscriptions.error || null
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      results,
      summary: {
        totalPages: results.length,
        pagesWithFeed: results.filter(r => r.hasFeed).length,
        pagesWithoutFeed: results.filter(r => !r.hasFeed).length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =======================
   SMS INTEGRATION
======================= */

async function sendSMS(phoneNumber, message) {
  try {
    const https = require('https');
    const querystring = require('querystring');
    
    const postData = querystring.stringify({
      apikey: process.env.SEMAPHORE_API_KEY,
      number: phoneNumber,
      message: message,
      sendername: process.env.SEMAPHORE_SENDER_NAME || 'KIARA'
    });
    
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.semaphore.co',
        port: 443,
        path: '/api/v4/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': postData.length
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.message_id || response[0]?.message_id) {
              console.log('✅ SMS sent:', phoneNumber);
              resolve({ success: true, data: response });
            } else {
              resolve({ success: false, data: response });
            }
          } catch (err) {
            resolve({ success: false, error: err });
          }
        });
      });
      
      req.on('error', (err) => resolve({ success: false, error: err }));
      req.write(postData);
      req.end();
    });
  } catch (err) {
    return { success: false, error: err };
  }
}

function formatBookingSMS(bookingData, config) {
  let name = '';
  let date = '';
  let details = [];
  
  config.forEach((stepConfig) => {
    const [stepNum, question, type] = stepConfig;
    const answer = bookingData[stepNum];
    
    if (!answer || answer === 'N/A') return;
    
    const questionLower = question.toLowerCase();
    
    if (questionLower.includes('name')) {
      name = answer;
    } else if (type === 'date' || questionLower.includes('date')) {
      date = answer;
    } else if (!(type === 'mobile' || type === 'phone' || type === 'contact')) {
      let label = question.replace(/\?/g, '').replace(/[📅📱👤🍨📏📝⏰💇🎯✅❌]/g, '').trim();
      label = label.split(/\s+/).pop();
      details.push(`${label}: ${answer}`);
    }
  });
  
  let smsText = `Booking Alert! New booking from ${name}`;
  if (date) smsText += ` on ${date}`;
  smsText += '.';
  if (details.length > 0) {
    smsText += '\n\n' + details.join('\n');
  }
  
  return smsText;
}

/* =======================
   BOOKING SYSTEM
======================= */

const bookingSessions = {};
const BOOKING_TIMEOUT = 30 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  Object.keys(bookingSessions).forEach(psid => {
    const session = bookingSessions[psid];
    if (session.startedAt && (now - session.startedAt.getTime() > BOOKING_TIMEOUT)) {
      delete bookingSessions[psid];
      console.log(`🧹 Cleaned up stale session: ${psid}`);
    }
  });
}

setInterval(cleanupStaleSessions, 10 * 60 * 1000);

async function startBooking(psid, bookingConfig) {
  bookingSessions[psid] = {
    step: 0,
    config: bookingConfig,
    data: {},
    startedAt: new Date()
  };

  return {
    text: null,
    template: {
      type: "template",
      payload: {
        template_type: "button",
        text: "Great! I'll help you with your booking.\n\nAre you ready to proceed?",
        buttons: [
          { type: "postback", title: "YES, Continue", payload: "BOOKING_YES" },
          { type: "postback", title: "NO, Cancel", payload: "BOOKING_NO" }
        ]
      }
    }
  };
}

function validateMobileNumber(number) {
  const cleaned = number.replace(/\D/g, '');
  return cleaned.length === 11 && cleaned.startsWith('09') 
    ? { valid: true, formatted: cleaned }
    : { valid: false, formatted: null };
}

function validateDateFormat(dateString) {
  const parsedDate = new Date(dateString.trim());
  
  if (isNaN(parsedDate.getTime())) return { valid: false };
  
  const now = new Date();
  const minDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const maxDate = new Date(now.getFullYear() + 2, 11, 31);
  
  if (parsedDate < minDate || parsedDate > maxDate) return { valid: false };

  const formattedDate = parsedDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return { valid: true, formatted: formattedDate };
}

function processBookingStep(psid, userMessage) {
  const session = bookingSessions[psid];
  if (!session || !session.config) {
    return { text: "Something went wrong. Please type 'order' to start again." };
  }

  const message = userMessage.toLowerCase().trim();
  const currentStepIndex = session.step;

  if (currentStepIndex === 0) {
    if (message.includes('yes') || message.includes('oo') || message.includes('sige')) {
      session.step = 1;
      return askQuestion(psid, 1);
    } else if (message.includes('no') || message.includes('cancel')) {
      delete bookingSessions[psid];
      return { text: "Booking cancelled. No problem! Feel free to book anytime." };
    }
  }

  if (currentStepIndex > 0) {
    const prevStep = session.config[currentStepIndex - 1];
    const fieldName = prevStep[0];
    const questionType = prevStep[2];

    if (questionType === 'mobile' || questionType === 'phone' || questionType === 'contact') {
      const validation = validateMobileNumber(userMessage);
      if (!validation.valid) {
        return { text: "Invalid mobile number!\n\nPlease enter exactly 11 digits starting with 09.\nExample: 09123456789" };
      }
      session.data[fieldName] = validation.formatted;
    } else if (questionType === 'date') {
      const validation = validateDateFormat(userMessage);
      if (!validation.valid) {
        return { text: "Invalid date format!\n\nPlease enter the date using a standard format.\nExample: 12/25/2025 or December 25, 2025" };
      }
      session.data[fieldName] = validation.formatted;
    } else {
      session.data[fieldName] = userMessage;
    }
  }

  if (currentStepIndex >= session.config.length) {
    return completeBooking(psid);
  }

  session.step = currentStepIndex + 1;
  return askQuestion(psid, currentStepIndex + 1);
}

function askQuestion(psid, stepIndex) {
  const session = bookingSessions[psid];
  const stepConfig = session.config[stepIndex - 1];

  if (!stepConfig) return completeBooking(psid);

  const [stepNum, question, type, options] = stepConfig;

  if (type === 'text') {
    return { text: question };
  } else if (type === 'mobile' || type === 'phone' || type === 'contact') {
    return { text: question + "\n\n(Enter 11 digits, e.g., 09123456789)" };
  } else if (type === 'date') {
    return { text: question + "\n\n(Format: MM/DD/YYYY or Month DD, YYYY)" };
  } else if (type === 'buttons' && options) {
    const optionList = options.split(',').map(opt => opt.trim());

    if (optionList.length <= 3) {
      const buttons = optionList.map(opt => {
        const [label, value] = opt.includes('-') ? opt.split('-') : [opt, opt];
        return { type: "postback", title: label, payload: `BOOKING_ANSWER_${value}` };
      });

      return {
        text: null,
        template: {
          type: "template",
          payload: { template_type: "button", text: question, buttons }
        }
      };
    } else {
      const elements = optionList.map(opt => {
        const [label, value] = opt.includes('-') ? opt.split('-') : [opt, opt];
        return {
          title: label,
          buttons: [{ type: "postback", title: `Choose ${label.split('-')[0]}`, payload: `BOOKING_ANSWER_${value}` }]
        };
      });

      return {
        text: null,
        template: {
          type: "template",
          payload: { template_type: "generic", elements }
        }
      };
    }
  }

  return { text: question };
}

function completeBooking(psid) {
  const session = bookingSessions[psid];
  let summary = "✅ BOOKING RECEIVED!\n\nSummary:\n";
  let mobileNumber = null;

  session.config.forEach((stepConfig) => {
    const [stepNum, question, type] = stepConfig;
    const answer = session.data[stepNum] || 'N/A';
    const label = question.replace('?', '').substring(0, 30);
    summary += `${label}: ${answer}\n`;

    if (type === 'mobile' || type === 'phone' || type === 'contact') {
      mobileNumber = session.data[stepNum];
    }
  });

  summary += "\nThank you! We'll confirm your booking shortly.";

  if (mobileNumber) {
    session.mobileNumber = mobileNumber;
    summary += "\n\n📱 A confirmation SMS will be sent to your number.";
  }

  session.completed = true;
  return { text: summary };
}

async function saveOrder(psid, orderData, bookingSheetId) {
  try {
    const values = [psid];
    const sortedKeys = Object.keys(orderData).sort();
    sortedKeys.forEach(key => values.push(orderData[key]));
    values.push(new Date().toISOString());
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: bookingSheetId,
      range: 'ConfirmedOrders!A:Z',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [values] },
    });
    
    console.log(`✅ Order saved: ${psid}`);
    return true;
  } catch (err) {
    console.error('❌ Error saving order:', err.message);
    return false;
  }
}

/* =======================
   UTILITIES
======================= */

const keywordsCache = {};

async function getPageConfig(pageId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:D',
    });

    const rows = res.data.values || [];
    const config = rows.find(row => row[0] === pageId);

    if (!config) return null;

    return {
      pageId: config[0],
      pageToken: config[1],
      keywordsSheetId: config[2],
      bookingSheetId: config[3] || config[2],
    };
  } catch (err) {
    console.error('Error fetching page config:', err);
    return null;
  }
}

async function getKeywords(sheetId, forceRefresh = false) {
  if (forceRefresh || !keywordsCache[sheetId]) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'KeywordsDM!A:C',
      });
      keywordsCache[sheetId] = res.data.values || [];
      console.log(`Keywords loaded: ${keywordsCache[sheetId].length}`);
    } catch (err) {
      console.error(`Error fetching keywords:`, err);
      return keywordsCache[sheetId] || [];
    }
  }
  return keywordsCache[sheetId];
}

async function getBookingConfig(sheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'BookingConfig!A:D',
    });
    return (res.data.values || []).slice(1);
  } catch (err) {
    console.error(`Error fetching booking config:`, err);
    return null;
  }
}

async function logPSID(psid) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'PSIDs!A:B',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [[psid, new Date().toISOString()]] },
    });
  } catch (err) {
    console.error('Error logging PSID:', err);
  }
}

function getCurrentTime() {
  return `Current time: ${new Date().toLocaleString('en-PH', { 
    timeZone: 'Asia/Manila',
    dateStyle: 'full',
    timeStyle: 'short'
  })}`;
}

async function executeSpecialAction(action) {
  return action === 'time' ? getCurrentTime() : null;
}

/* =======================
   MESSENGER API HELPERS
======================= */

function sendTyping(senderPsid, pageToken) {
  request({
    uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
    qs: { access_token: pageToken },
    method: 'POST',
    json: { recipient: { id: senderPsid }, sender_action: 'typing_on' },
  }, (err) => {
    if (err) console.error('Typing error:', err.message);
  });
}

function callSendAPI(senderPsid, response, pageToken, quickReplies = null, template = null, imageUrl = null) {
  let messageData = { recipient: { id: senderPsid } };
  
  if (template) {
    messageData.message = { attachment: template };
  } else if (imageUrl) {
    messageData.message = {
      attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } }
    };
  } else if (quickReplies) {
    messageData.message = { text: response, quick_replies: quickReplies };
  } else {
    messageData.message = { text: response };
  }
  
  request({
    uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
    qs: { access_token: pageToken },
    method: 'POST',
    json: messageData,
  }, (err, res, body) => {
    if (err) console.error('❌ Send error:', err.message);
  });
}

/* =======================
   COMMENT PROTECTION
======================= */

const processedComments = new Set();
const MAX_PROCESSED_COMMENTS = 1000;

setInterval(() => {
  if (processedComments.size > MAX_PROCESSED_COMMENTS) {
    console.log(`🧹 Clearing ${processedComments.size} processed comments`);
    processedComments.clear();
  }
}, 60 * 60 * 1000);

/* =======================
   WEBHOOK HANDLERS
======================= */

app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('\n📥 Webhook:', JSON.stringify(body, null, 2));

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const pageId = entry.id;
      const config = await getPageConfig(pageId);

      if (!config) {
        console.error(`❌ No config for page ${pageId}`);
        continue;
      }

      const { pageToken, keywordsSheetId, bookingSheetId } = config;

      // HANDLE MESSAGES
      if (entry.messaging) {
        for (const messaging of entry.messaging) {
          
          // POSTBACKS
          if (messaging.postback) {
            const senderPsid = messaging.sender.id;
            const payload = messaging.postback.payload;
            
            console.log(`📲 Postback: ${payload}`);
            
            if (payload === 'BOOKING_YES') {
              if (bookingSessions[senderPsid]?.step === 0) {
                bookingSessions[senderPsid].step = 1;
                const nextQuestion = askQuestion(senderPsid, 1);
                sendTyping(senderPsid, pageToken);
                setTimeout(() => {
                  if (nextQuestion.template) {
                    callSendAPI(senderPsid, null, pageToken, null, nextQuestion.template);
                  } else {
                    callSendAPI(senderPsid, nextQuestion.text, pageToken);
                  }
                }, 1000);
              }
            } else if (payload === 'BOOKING_NO') {
              delete bookingSessions[senderPsid];
              callSendAPI(senderPsid, "Booking cancelled. Feel free to book anytime!", pageToken);
            } else if (payload.startsWith('BOOKING_ANSWER_')) {
              const answer = payload.replace('BOOKING_ANSWER_', '').replace(/_/g, ' ');
              
              if (answer === 'Other date') {
                bookingSessions[senderPsid].waitingForCustomDate = true;
                callSendAPI(senderPsid, "Please type your preferred date (e.g., December 25, 2025):", pageToken);
                continue;
              }

              if (bookingSessions[senderPsid]) {
                const currentStep = bookingSessions[senderPsid].step;
                const stepConfig = bookingSessions[senderPsid].config[currentStep - 1];
                if (stepConfig) {
                  bookingSessions[senderPsid].data[stepConfig[0]] = answer;
                }
                
                const nextQuestion = processBookingStep(senderPsid, answer);
                sendTyping(senderPsid, pageToken);
                setTimeout(() => {
                  if (nextQuestion.template) {
                    callSendAPI(senderPsid, null, pageToken, null, nextQuestion.template);
                  } else {
                    callSendAPI(senderPsid, nextQuestion.text, pageToken);
                  }
                }, 1000);
              }
            }
            continue;
          }
          
          // MESSAGES
          if (messaging.message?.text) {
            const senderPsid = messaging.sender.id;
            const receivedText = messaging.message.text.toLowerCase().trim();
            
            // Refresh keywords
            if (receivedText === 'refresh data') {
              await getKeywords(keywordsSheetId, true);
              callSendAPI(senderPsid, '✅ Keywords refreshed!', pageToken);
              continue;
            }
            
            // Handle booking flow
            if (bookingSessions[senderPsid]) {
              
              // Custom date input
              if (bookingSessions[senderPsid].waitingForCustomDate) {
                const validation = validateDateFormat(messaging.message.text);
                if (!validation.valid) {
                  callSendAPI(senderPsid, "Invalid date! Please use MM/DD/YYYY or Month DD, YYYY.", pageToken);
                  continue;
                }
                
                const currentStep = bookingSessions[senderPsid].step;
                const stepConfig = bookingSessions[senderPsid].config[currentStep - 1];
                if (stepConfig) {
                  bookingSessions[senderPsid].data[stepConfig[0]] = validation.formatted;
                }
                delete bookingSessions[senderPsid].waitingForCustomDate;
                bookingSessions[senderPsid].step++;
                
                const nextQuestion = askQuestion(senderPsid, bookingSessions[senderPsid].step);
                sendTyping(senderPsid, pageToken);
                setTimeout(() => {
                  if (nextQuestion.template) {
                    callSendAPI(senderPsid, null, pageToken, null, nextQuestion.template);
                  } else {
                    callSendAPI(senderPsid, nextQuestion.text, pageToken);
                  }
                }, 1000);
                continue;
              }

              // Process booking steps
              const bookingReply = processBookingStep(senderPsid, messaging.message.text);
              
              // Check if completed
              if (bookingSessions[senderPsid]?.completed) {
                const session = bookingSessions[senderPsid];
                await saveOrder(senderPsid, session.data, bookingSheetId);
                
                if (session.mobileNumber && process.env.SEMAPHORE_API_KEY) {
                  const smsMessage = formatBookingSMS(session.data, session.config);
                  await sendSMS(session.mobileNumber, smsMessage);
                }
                delete bookingSessions[senderPsid];
              }
              
              sendTyping(senderPsid, pageToken);
              setTimeout(() => {
                if (bookingReply.template) {
                  callSendAPI(senderPsid, null, pageToken, null, bookingReply.template);
                } else {
                  callSendAPI(senderPsid, bookingReply.text, pageToken);
                }
              }, 1000);
              continue;
            }
            
            // New conversation - log user
            await logPSID(senderPsid);
            const keywords = await getKeywords(keywordsSheetId);
            
            // Check for booking keywords
            if (receivedText.includes('order') || receivedText.includes('book')) {
              const bookingConfig = await getBookingConfig(bookingSheetId);
              if (bookingConfig?.length > 0) {
                const bookingReply = await startBooking(senderPsid, bookingConfig);
                sendTyping(senderPsid, pageToken);
                setTimeout(() => {
                  callSendAPI(senderPsid, null, pageToken, null, bookingReply.template);
                }, 1000);
              } else {
                callSendAPI(senderPsid, "Sorry, booking is not available at the moment.", pageToken);
              }
              continue;
            }

            // Keyword matching
            const match = keywords.find(row => {
              if (!row[0]) return false;
              const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
              return keywordList.some(keyword => receivedText.includes(keyword));
            });

            let reply = "Sorry, I didn't understand that. Can you rephrase?";
            let imageUrls = [];
            
            if (match) {
              const column_c = match[2]?.trim();
              
              // Check for images
              if (column_c?.startsWith('http')) {
                imageUrls = column_c.split('|').map(url => url.trim()).filter(Boolean);
              }
              
              // Check for special actions
              if (imageUrls.length === 0 && column_c) {
                const actionResult = await executeSpecialAction(column_c.toLowerCase());
                reply = actionResult || match[1];
              } else if (match[1]) {
                const responses = match[1].split('|').map(r => r.trim());
                reply = responses[Math.floor(Math.random() * responses.length)];
              }
            }

            sendTyping(senderPsid, pageToken);
            setTimeout(() => {
              callSendAPI(senderPsid, reply, pageToken);
              
              // Send images if any
              if (imageUrls.length > 0) {
                setTimeout(() => {
                  imageUrls.forEach(url => {
                    callSendAPI(senderPsid, null, pageToken, null, null, url);
                  });
                }, 500);
              }
            }, 1000);
          }
        }
      }

      // ✅ HANDLE COMMENTS
      if (entry.changes) {
        for (const change of entry.changes) {
          
          console.log(`📋 Change detected - Field: ${change.field}, Item: ${change.value?.item}`);
          
          if (change.field === 'feed' && change.value?.item === 'comment') {
            const commentId = change.value.comment_id;
            const commentMessage = change.value.message;
            const commenterId = change.value.from?.id;
            const commenterName = change.value.from?.name || 'Unknown';
            
            // Validation
            if (!commenterId || !commentMessage) {
              console.log(`⚠️ Missing data for comment ${commentId}`);
              continue;
            }
            
            // Duplicate check
            if (processedComments.has(commentId)) {
              console.log(`⚠️ Duplicate comment: ${commentId}`);
              continue;
            }
            
            processedComments.add(commentId);
            
            console.log(`\n📝 NEW COMMENT`);
            console.log(`├─ From: ${commenterName} (${commenterId})`);
            console.log(`├─ Comment ID: ${commentId}`);
            console.log(`└─ Message: ${commentMessage}\n`);
            
            // Get keywords
            const keywords = await getKeywords(keywordsSheetId);
            const commentLower = commentMessage.toLowerCase().trim();
            
            // Match keywords
            const match = keywords.find(row => {
              if (!row[0]) return false;
              const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
              return keywordList.some(keyword => commentLower.includes(keyword));
            });
            
            let dmMessage = "Hi! Thanks for commenting on our post. How can I help you? 😊";
            let imageUrls = [];
            
            if (match) {
              const column_c = match[2]?.trim();
              
              // Check for images
              if (column_c?.startsWith('http')) {
                imageUrls = column_c.split('|').map(url => url.trim()).filter(Boolean);
              }
              
              // Get custom message
              if (match[1]) {
                const responses = match[1].split('|').map(r => r.trim());
                dmMessage = responses[Math.floor(Math.random() * responses.length)];
              }
            }
            
            // Send DM to commenter
            setTimeout(() => {
              console.log(`💬 Sending DM to ${commenterId}...`);
              sendTyping(commenterId, pageToken);
              
              setTimeout(() => {
                callSendAPI(commenterId, dmMessage, pageToken);
                console.log(`✅ DM sent to ${commenterName}`);
                
                // Send images
                if (imageUrls.length > 0) {
                  setTimeout(() => {
                    imageUrls.forEach(url => {
                      callSendAPI(commenterId, null, pageToken, null, null, url);
                    });
                    console.log(`✅ Sent ${imageUrls.length} image(s)`);
                  }, 500);
                }
              }, 1500);
              
              // Log PSID
              logPSID(commenterId);
              
              // Check for booking keywords in comment
              if (commentLower.includes('book') || 
                  commentLower.includes('order') || 
                  commentLower.includes('reserve') ||
                  commentLower.includes('appointment')) {
                
                console.log(`📅 Booking keyword detected in comment`);
                
                setTimeout(async () => {
                  const bookingConfig = await getBookingConfig(bookingSheetId);
                  
                  if (bookingConfig?.length > 0) {
                    const bookingReply = await startBooking(commenterId, bookingConfig);
                    
                    setTimeout(() => {
                      if (bookingReply.template) {
                        callSendAPI(commenterId, null, pageToken, null, bookingReply.template);
                        console.log(`✅ Booking flow started for ${commenterName}`);
                      }
                    }, 2000);
                  }
                }, 3000);
              }
            }, 2000);
          }
        }
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

/* =======================
   SERVER START
======================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Graph API: ${process.env.GRAPH_API_VERSION || 'v21.0'}`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`📋 Available endpoints:`);
  console.log(`   GET  /webhook              - Webhook verification`);
  console.log(`   POST /webhook              - Receive events`);
  console.log(`   GET  /health               - Health check`);
  console.log(`   GET  /subscribe-feed       - Subscribe pages to feed`);
  console.log(`   GET  /check-subscriptions  - Check subscription status`);
  console.log(`${'='.repeat(80)}\n`);
});