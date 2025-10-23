const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config(); // .env फ़ाइल से वेरिएबल्स लोड करने के लिए

const app = express();

// --- Middleware ---
app.use(cors()); 
app.use(express.json());

// --- एनवायरनमेंट वेरिएबल्स (आपकी सीक्रेट कीज़) ---
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SALT_KEY;
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX;

// <<< NAYA BADLAV (बेहतर तरीका) >>>
// अपना Render.com URL .env फ़ाइल से लोड करें
const BACKEND_HOSTNAME = process.env.BACKEND_HOSTNAME; 

// PhonePe का LIVE API URL
const PHONEPE_PAY_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";

// --- API Endpoints ---

/**
 * =================================================================
 * 1. पेमेंट शुरू करने वाला एंडपॉइंट
 * =================================================================
 */
app.post('/initiate-phonepe-payment', async (req, res) => {
    
    try {
        const frontendData = req.body.data;
        
        const merchantTransactionId = `MUID-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        
        // <<< NAYA BADLAV (बेहतर तरीका) >>>
        // callbackUrl को हार्डकोड करने के बजाय .env वेरिएबल का उपयोग करें
        if (!BACKEND_HOSTNAME) {
            throw new Error("BACKEND_HOSTNAME .env में सेट नहीं है");
        }
        const callbackUrl = `${BACKEND_HOSTNAME}/phonepe-callback`;

        const payload = {
            merchantId: MERCHANT_ID,
            merchantTransactionId: merchantTransactionId,
            merchantUserId: frontendData.customer_details.customer_id,
            amount: frontendData.amount * 100, // **'paise' में**
            redirectUrl: frontendData.success_return_url,
            redirectMode: "POST", 
            callbackUrl: callbackUrl, // अपडेटेड
            mobileNumber: frontendData.customer_details.customer_phone,
            paymentInstrument: {
                type: "PAY_PAGE"
            }
        };

        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const stringToHash = base64Payload + "/pg/v1/pay" + SALT_KEY;
        const sha256Hash = crypto.createHash('sha256').update(stringToHash).digest('hex');
        const xVerifyHeader = sha256Hash + "###" + SALT_INDEX;

        const options = {
            method: 'post',
            url: PHONEPE_PAY_URL,
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': xVerifyHeader
            },
            data: {
                request: base64Payload
            }
        };

        console.log("PhonePe को रिक्वेस्ट भेजी जा रही है...");
        const response = await axios(options);
        console.log("PhonePe से रिस्पॉन्स मिला:", response.data);

        if (response.data.success && response.data.data.instrumentResponse.redirectInfo.url) {
            const redirectUrl = response.data.data.instrumentResponse.redirectInfo.url;
            res.json({
                success: true,
                redirectUrl: redirectUrl
            });
        } else {
            res.status(500).json({ 
                success: false, 
                message: response.data.message || "PhonePe से रीडायरेक्ट URL नहीं मिला" 
            });
        }

    } catch (error) {
        // <<< ============ ZAROORI BADLAV YAHAN HAI ============ >>>
        // एरर हैंडलिंग को ठीक किया गया है

        console.error("पेमेंट शुरू करने में एरर:", error.message);
        
        if (error.response) {
            // अगर PhonePe के सर्वर से एरर आया है (जैसे 404, 500)
            console.error("PhonePe Error Response:", error.response.data);
            
            const errorData = error.response.data;
            // PhonePe कभी 'message' भेजता है, कभी 'code'। हम दोनों को हैंडल करेंगे।
            const errorMessage = errorData.message || errorData.code || JSON.stringify(errorData);
            
            res.status(500).json({ success: false, message: errorMessage });
        
        } else {
            // अगर कोई और एरर (जैसे नेटवर्क) आती है
            res.status(500).json({ success: false, message: error.message });
        }
        // <<< ================================================== >>>
    }
});


/**
 * =================================================================
 * 2. सर्वर-से-सर्वर कॉलबैक एंडपॉइंट (अब सुरक्षित)
 * =================================================================
 */
app.post('/phonepe-callback', (req, res) => {
    
    console.log("--- PhonePe कॉलबैक मिला ---");
    
    try {
        // <<< ============ ZAROORI SURAKSHA BADLAV ============ >>>
        // 1. PhonePe से मिला हेडर
        const xVerifyHeader = req.headers['x-verify'];

        // 2. PhonePe से मिला पेलोड (Base64 एन्कोडेड)
        const base64Response = req.body.response;

        if (!base64Response || !xVerifyHeader) {
            console.log("अमान्य कॉलबैक: ज़रूरी डेटा (response या x-verify) नहीं मिला।");
            return res.status(400).send("Bad Request: Invalid callback");
        }
        
        // 3. सिग्नेचर खुद बनाएँ (Verify करने के लिए)
        const stringToHash = base64Response + SALT_KEY;
        const sha256Hash = crypto.createHash('sha256').update(stringToHash).digest('hex');
        const calculatedVerifyHeader = sha256Hash + "###" + SALT_INDEX;

        // 4. दोनों सिग्नेचर की तुलना करें
        if (xVerifyHeader !== calculatedVerifyHeader) {
            console.error("असुरक्षित कॉलबैक! X-VERIFY सिग्नेचर मैच नहीं हुआ।");
            return res.status(401).send("Unauthorized: Signature mismatch");
        }
        
        // <<< जाँच सफल! अब हम इस डेटा पर भरोसा कर सकते हैं >>>
        console.log("X-VERIFY सिग्नेचर सफलतापूर्वक जाँचा गया।");

        // 5. Base64 को डीकोड करें
        const decodedResponse = Buffer.from(base64Response, 'base64').toString('utf8');
        const data = JSON.parse(decodedResponse);

        console.log("कॉलबैक डेटा:", JSON.stringify(data, null, 2));

        // 6. ट्रांजेक्शन ID और स्थिति (Status) चेक करें
        const merchantTransactionId = data.data.merchantTransactionId;
        const paymentStatus = data.code; // e.g., "PAYMENT_SUCCESS"

        if (paymentStatus === "PAYMENT_SUCCESS") {
            // 7. 🔔 यहाँ अपना डेटाबेस अपडेट करें 🔔
            console.log(`पेमेंट सफल: ${merchantTransactionId}. डेटाबेस अपडेट करें।`);

        } else if (paymentStatus === "PAYMENT_ERROR") {
            console.log(`पेमेंट फेल: ${merchantTransactionId}. स्थिति: ${data.message}`);
        } else {
            console.log(`पेमेंट स्थिति: ${paymentStatus} - ${merchantTransactionId}`);
        }
        
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
    // <<< NAYA BADLAV >>>
    console.log(`Backend Host: ${BACKEND_HOSTNAME ? BACKEND_HOSTNAME : 'NOT SET'}`);
});
