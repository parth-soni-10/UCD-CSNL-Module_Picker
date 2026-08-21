const fs = require("fs");
const file = process.argv[2];
const term = process.argv[3] || "COMP30960";
const before = parseInt(process.argv[4] || "400", 10);
const after = parseInt(process.argv[5] || "1800", 10);
let s = fs.readFileSync(file, "utf8");
s = s
  .replace(/<script[\s\S]*?<\/script>/g, " ")
  .replace(/<style[\s\S]*?<\/style>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/\s+/g, " ");
const i = s.indexOf(term);
console.log(i >= 0 ? s.slice(Math.max(0, i - before), i + after) : s.slice(0, 1500));
