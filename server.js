const express = require("express");
const app = express();

app.use(express.json());

// test
app.get("/", (req, res) => {
  res.send("Server OK");
});

// webhook SePay
app.post("/sepay-webhook", (req, res) => {
  console.log("Webhook nhận:", req.body);

  // TODO: xử lý thanh toán ở đây

  res.send("OK");
});

app.listen(3000, () => {
  console.log("Server chạy port 3000");
});
