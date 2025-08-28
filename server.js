// server.js
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

import cors from "cors";


// Cho phép tất cả origin (dev/test)
app.use(cors());

// ========== MONGODB ==========
const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let ordersCollection;
async function initMongo() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas");
    const db = client.db("meostore");
    ordersCollection = db.collection("orders");

    // Tạo index cho orderCode để tìm nhanh
    await ordersCollection.createIndex({ orderCode: 1 }, { unique: true });
  } catch (err) {
    console.error("❌ MongoDB connect error:", err.message);
    process.exit(1);
  }
}
initMongo();

// ========== Middleware giữ rawBody cho webhook ==========
app.use(
  "/casso-webhook",
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use(express.json());

app.post("/create-order", async (req, res) => {
  try {
    const { uid, amount } = req.body;
    if (!uid || !amount) {
      return res.status(400).json({ error: "Missing uid or amount" });
    }

    const orderCode =
      "MEOSTORE-" + Math.floor(100000 + Math.random() * 900000);

    const order = {
      orderCode,
      uid,
      amount,
      status: "Chờ thanh toán",
      createdAt: new Date(),
    };

    await ordersCollection.insertOne(order);

    // ⚡ Thay số tài khoản thật bằng VA CASSxxxx
    const bankBin = "970448"; // BIN OCB
    const accountNo = "CASS199188177997"; // VA cấp bởi Casso
    const accountName = "DONG THI THU HA"; // Tên tài khoản gốc

    const qrUrl = `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.png?amount=${amount}&addInfo=${orderCode}&accountName=${encodeURIComponent(accountName)}`;

    res.json({
      success: true,
      orderCode,
      transferDesc: `${orderCode} - Nạp UID ${uid}`,
      amount,
      qrUrl
    });
  } catch (err) {
    console.error("❌ Create order error:", err.message);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ========== Verify chữ ký Webhook V2 ==========
function verifyCassoSignature(rawBody, signatureHeader, secret) {
  // Nếu đang DEV thì bỏ qua verify
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((seg) => {
      const [k, v] = seg.split("=");
      return [k.trim(), v.trim()];
    })
  );

  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const signedPayload = `${t}.${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  return hmac === v1;
}

// ========== Webhook V2 ==========
app.post("/casso-webhook", async (req, res) => {
  try {
    const signature = req.get("X-Casso-Signature") || "";
    const ok = verifyCassoSignature(
      req.rawBody,
      signature,
      process.env.CASSO_SECRET
    );

    // ⚠️ Trong dev thì bỏ qua verify, prod thì check thật
    if (!ok && process.env.NODE_ENV !== "development") {
      console.warn("❌ Invalid Casso Signature");
      return res.json({ success: true }); // vẫn trả success để tránh Casso retry
    }

    const body = req.body;
    if (body.error !== 0 || !body.data) {
      return res.json({ success: true });
    }

    const tx = body.data;
    const desc = tx.description || "";

    // Log toàn bộ giao dịch để dễ debug
    console.log("📩 Webhook nhận được transaction:", JSON.stringify(tx, null, 2));

    // Regex chấp nhận cả MEOSTORE-123456 và MEOSTORE123456
    const match = desc.match(/MEOSTORE[-]?(\d+)/i);

    if (match) {
      const orderCode = `MEOSTORE-${match[1]}`; // chuẩn hóa luôn có dấu gạch ngang
      const result = await ordersCollection.findOneAndUpdate(
        { orderCode },
        {
          $set: {
            status: "Đã thanh toán",
            paidAt: new Date(),
            txId: tx.id,
            bankDescription: desc
          },
        }
      );

      if (result.value) {
        console.log(`💰 Order ${orderCode} updated to PAID`);
      } else {
        console.warn(`⚠️ Không tìm thấy đơn hàng ${orderCode} trong DB`);
      }
    } else {
      console.warn("⚠️ Không tìm thấy orderCode trong description:", desc);
    }

    // Casso yêu cầu luôn trả success:true
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.json({ success: true }); // tránh retry spam
  }
});


// ========== Xem trạng thái đơn hàng ==========
app.get("/order/:orderCode", async (req, res) => {
  try {
    const order = await ordersCollection.findOne({
      orderCode: req.params.orderCode,
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    console.error("❌ Get order error:", err.message);
    res.status(500).json({ error: "Failed to get order" });
  }
});

// ========== START ==========
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});




