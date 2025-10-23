const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config(); // .env फ़ाइल से वेरिएबल्स लोड करने के लिए

const app = express();

// --- Middleware ---
// 1. CORS: आपके frontend (dfordeal.shop) से आने वाली रिक्वेस्ट को अलाउ करने के लिए
app.use(cors()); 
// 2. JSON Parser: frontend से भेजे गए JSON डेटा को पढ़ने के लिए
app.use(express.json());

// --- एनवायरनमेंट वेरिएबल्स (आपकी सीक्रेट कीज़) ---
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SALT_KEY;
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX;

// PhonePe का LIVE API URL
const PHONEPE_PAY_URL = "https://api.phonepe.com/pg/v1/pay";

// --- API Endpoints ---

/**
 * =================================================================
 * 1. पेमेंट शुरू करने वाला एंडपॉइंट
 * =================================================================
 * यह वह एंडपॉइंट है जिसे आपका HTML पेज कॉल करेगा।
 * frontend से `PAYMENT_BACKEND_URL` को इस पर सेट करें।
 * जैसे: 'https://your-backend.onrender.com/initiate-phonepe-payment'
 */
app.post('/initiate-phonepe-payment', async (req, res) => {
    
    try {
        // 1. Frontend से आया डेटा (यह वही 'data' ऑब्जेक्ट है जो आपने JS में बनाया था)
        const frontendData = req.body.data;
        
        // 2. एक यूनिक ट्रांजेक्शन ID बनाएँ
        const merchantTransactionId = `MUID-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        
        // 3. PhonePe API के लिए पेलोड (Payload) तैयार करें
        const payload = {
            merchantId: MERCHANT_ID,
            merchantTransactionId: merchantTransactionId,
            merchantUserId: frontendData.customer_details.customer_id,
            amount: frontendData.amount * 100, // **सबसे ज़रूरी: PhonePe को amount "paise" में चाहिए**
            redirectUrl: frontendData.success_return_url,
            redirectMode: "POST", // 'POST' का उपयोग करें ताकि आप पेमेंट के बाद डेटा को वेरिफाई कर सकें
            
            // यह वह URL है जिस पर PhonePe पेमेंट के बाद सर्वर-से-सर्वर पिंग करेगा
            callbackUrl: "https://phonepe-1q12.onrender.com/phonepe-callback", // <<< अपना खुद का callback URL यहाँ डालें
            
            mobileNumber: frontendData.customer_details.customer_phone,
            paymentInstrument: {
                type: "PAY_PAGE" // यह यूज़र को PhonePe के पेमेंट पेज पर रीडायरेक्ट करेगा
            }
        };

        // 4. पेलोड को Base64 में एन्कोड करें
        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');

        // 5. X-VERIFY सिग्नेचर (Signature) बनाएँ
        // यह PhonePe इंटीग्रेशन का सबसे मुश्किल हिस्सा है
        const stringToHash = base64Payload + "/pg/v1/pay" + SALT_KEY;
        const sha256Hash = crypto.createHash('sha256').update(stringToHash).digest('hex');
        const xVerifyHeader = sha256Hash + "###" + SALT_INDEX;

        // 6. Axios (HTTP क्लाइंट) के लिए ऑप्शन तैयार करें
        const options = {
            method: 'post',
            url: PHONEPE_PAY_URL,
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': xVerifyHeader
            },
            data: {
                request: base64Payload // **ध्यान दें: पेलोड 'request' की (key) के अंदर भेजा जाता है**
            }
        };

        // 7. PhonePe API को कॉल करें
        console.log("PhonePe को रिक्वेस्ट भेजी जा रही है...");
        const response = await axios(options);
        console.log("PhonePe से रिस्पॉन्स मिला:", response.data);

        // 8. PhonePe से मिला रीडायरेक्ट URL वापस Frontend को भेजें
        if (response.data.success && response.data.data.instrumentResponse.redirectInfo.url) {
            
            const redirectUrl = response.data.data.instrumentResponse.redirectInfo.url;
            
            // यह वही रिस्पॉन्स है जिसका आपका Frontend इंतज़ार कर रहा है
            res.json({
                success: true,
                redirectUrl: redirectUrl
            });
        } else {
            // अगर कोई एरर आती है
            res.status(500).json({ 
                success: false, 
                message: response.data.message || "PhonePe से रीडायरेक्ट URL नहीं मिला" 
            });
        }

    } catch (error) {
        // एरर हैंडलिंग
        console.error("पेमेंट शुरू करने में एरर:", error.message);
        if (error.response) {
            console.error("PhonePe Error Response:", error.response.data);
            res.status(500).json({ success: false, message: error.response.data.message });
        } else {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});


/**
 * =================================================================
 * 2. सर्वर-से-सर्वर कॉलबैक एंडपॉइंट
 * =================================================================
 * यह वह URL है जो आपने ऊपर `callbackUrl` में सेट किया था।
 * PhonePe पेमेंट पूरा होने पर इस एंडपॉइंट को बैकग्राउंड में पिंग करेगा।
 * यहाँ आप अपने डेटाबेस में ऑर्डर को "Paid" मार्क कर सकते हैं।
 */
app.post('/phonepe-callback', (req, res) => {
    
    console.log("--- PhonePe कॉलबैक ---");
    
    try {
        // PhonePe एक 'X-VERIFY' हेडर भी भेजेगा, आपको उसे यहाँ वेरिफाई करना चाहिए
        // (यह आपकी होम असाइनमेंट है: X-VERIFY को वैसे ही वेरिफाई करें जैसे ऊपर किया था)
        
        // PhonePe से मिला पेलोड (Base64 एन्कोडेड)
        const base64Response = req.body.response;

        if (!base64Response) {
            console.log("खाली कॉलबैक मिला।");
            return res.status(400).send("Bad Request: No response payload");
        }

        // Base64 को डीकोड करें
        const decodedResponse = Buffer.from(base64Response, 'base64').toString('utf8');
        const data = JSON.parse(decodedResponse);

        console.log("कॉलबैक डेटा:", JSON.stringify(data, null, 2));

        // 1. ट्रांजेक्शन ID और स्थिति (Status) चेक करें
        const merchantTransactionId = data.data.merchantTransactionId;
        const paymentStatus = data.code; // e.g., "PAYMENT_SUCCESS"

        if (paymentStatus === "PAYMENT_SUCCESS") {
            // 2. 🔔 यहाँ अपना डेटाबेस अपडेट करें 🔔
            // उदा. 
            // await database.orders.update(
            //   { transactionId: merchantTransactionId },
            //   { status: "Paid" }
            // );
            console.log(`पेमेंट सफल: ${merchantTransactionId}. डेटाबेस अपडेट करें।`);

        } else if (paymentStatus === "PAYMENT_ERROR") {
            // पेमेंट फेल हो गई
            console.log(`पेमेंट फेल: ${merchantTransactionId}. स्थिति: ${data.message}`);
        } else {
            // पेमेंट पेंडिंग या कोई और स्थिति
            console.log(`पेमेंट स्थिति: ${paymentStatus} - ${merchantTransactionId}`);
        }
        
        // 3. PhonePe को जवाब भेजें कि कॉलबैक मिल गया
        // (यह ज़रूरी नहीं है, लेकिन एक अच्छा अभ्यास है)
        res.status(200).json({ success: true, message: "Callback received" });

    } catch (error) {
        console.error("कॉलबैक हैंडल करने में एरर:", error.message);
        res.status(500).send("Internal Server Error");
    }
});


// --- सर्वर शुरू करें ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`सर्वर ${PORT} पर चल रहा है...`);
    console.log(`मर्चेंट ID: ${MERCHANT_ID ? MERCHANT_ID.substring(0, 5) + '...' : 'NOT SET'}`);
    console.log(`Salt Key: ${SALT_KEY ? 'SET' : 'NOT SET'}`);

});
