import { all, ready } from "./lib/db.js";
import { readFileSync } from "fs";
await ready();
function parseCsv(text){
  const lines=text.split("\n").filter(Boolean);
  const head=lines[0].split(",");
  return lines.slice(1).map(line=>{
    const m=[...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map(x=>x[1].replace(/^"|"$/g,'').replace(/""/g,'"'));
    const o={}; head.forEach((h,i)=>o[h]=(m[i]||"").trim()); return o;
  });
}
const rows=parseCsv(readFileSync("enrich-founder-name-ranked.csv","utf8"));
console.log("Plan: rows with a founder_name that map to a sendable DB lead currently missing founder.\n");
let n=0, skipFirstOnly=0, skipMismatch=0;
for(const r of rows){
  const founder=(r.founder_name||"").trim();
  if(!founder) continue;
  const lead=(await all("SELECT id,founder_name,contact,do_not_email FROM leads WHERE lower(brand)=lower(?)",[r.brand]))[0];
  if(!lead){ console.log(`  NO LEAD   ${r.brand}`); continue; }
  if(lead.founder_name){ continue; } // already has one
  const flags=[];
  if(/CONTACT MISMATCH/i.test(r.founder_note||"")) flags.push("CONTACT-MISMATCH");
  if(!/\s/.test(founder)) flags.push("FIRST-NAME-ONLY");
  n++;
  console.log(`  ${String(n).padStart(2)}  [${r.founder_confidence}] ${r.brand}  ->  "${founder}"  ${flags.join(" ")}`);
}
console.log(`\nWould update ${n} leads.`);
