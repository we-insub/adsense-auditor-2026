import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './storage.js';
import { JobRunner, reportData } from './jobs.js';
import { buildEvidenceBundle, failureLabel, hasDirectPageEvidence, retryAction } from './evidence.js';
import { normalizePageUrl, validateTargetSyntax } from './scanner.js';
import { FEATURES_TEXT, NOTICE_TEXT, REPAIR_PROMPT_TEXT, exportReport, fillDeliveryText, readableReason, renderReport } from './report.js';
import type { ScanMode } from './types.js';

const DOC = `1. 서비스 공지를 게시한 뒤 고객에게 URL과 검사 제외 경로를 받습니다. 접수 메시지는 관리자가 보관합니다.
2. 이 로컬 채점기에 URL을 넣고 빠른 표본 20페이지 또는 기본 200페이지 검사를 실행합니다. 별도 전체 검사를 맡은 경우 관리자 전체 검사를 선택합니다.
3. 접근 실패·확인 불가·오탐 가능성이 있는 항목을 확인합니다. PDF를 내보내 고객에게 직접 전송합니다. 메시지나 이메일은 자동 전송되지 않습니다.`;
const style = `
  :root{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;color:#182633;background:#f3f6f8}
  *{box-sizing:border-box} body{margin:0} header{background:#122b38;color:white;padding:18px 28px;display:flex;gap:24px;align-items:center;justify-content:space-between}
  header a{color:#d7f3e9;text-decoration:none}main{max-width:1200px;margin:32px auto;padding:0 20px 60px}
  h1{font-size:27px;margin:0 0 8px}h2{font-size:20px;margin:0 0 16px}p{line-height:1.6}small,.muted{color:#667985}
  .grid{display:grid;grid-template-columns:1.35fr 1fr;gap:20px}.card{background:#fff;border:1px solid #dce5e9;border-radius:14px;padding:23px;margin-bottom:18px;box-shadow:0 3px 16px #172c3608}
  label{display:block;font-weight:700;margin:14px 0 7px}input[type=url],input[type=password],textarea,select{width:100%;padding:12px 13px;border:1px solid #aebfc8;border-radius:8px;font:inherit;background:#fff}
  textarea{min-height:95px;resize:vertical}button,.button{border:0;border-radius:8px;padding:10px 16px;background:#087e6e;color:#fff;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}
  button.secondary,.button.secondary{background:#e7f1ef;color:#155c51}.danger{background:#b43a43}button:disabled{opacity:.45;cursor:default}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .notice{background:#fff6db;border-left:4px solid #b48515;padding:12px 16px;border-radius:6px}.error{color:#ab2636}.success{color:#087e6e}
  table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e0e8ec;padding:11px;text-align:left;vertical-align:top}th{font-size:13px;color:#50636f}td{font-size:14px}
  .nowrap{white-space:nowrap}.mono{font-family:ui-monospace,Menlo,monospace;word-break:break-all}.copybox{white-space:pre-wrap;background:#f4f8f7;border:1px solid #deebe7;padding:15px;border-radius:8px;line-height:1.6}
  .metrics{display:flex;gap:12px;flex-wrap:wrap}.metric{background:#ecf4f3;padding:12px 16px;border-radius:9px;min-width:125px}.metric strong{display:block;font-size:24px}
  .score-panel{margin-top:17px;padding:18px;border:1px solid #b8d9d4;border-radius:12px;background:#f1f8f6}.score-panel h2{margin:0 0 10px}.score-panel p{margin:8px 0}.score-panel .score-head{font-size:24px;font-weight:800;color:#155c51}.score-panel .score-head.hold{color:#8b5414}.score-metrics{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:8px;margin:12px 0}.score-metrics div{background:white;border:1px solid #d8e6e3;border-radius:8px;padding:8px 10px}.score-metrics strong{display:block;font-size:19px;color:#234650}.score-metrics span{font-size:12px;color:#526b70}.score-panel .score-explain{font-size:13px;color:#51676e}.score-panel .hold-reason{padding:9px 12px;background:#fff2d9;border-left:4px solid #c78b26;border-radius:4px;color:#684617}.score-panel .score-grade{display:inline-block;font-size:15px;padding:2px 10px;border-radius:18px;background:#d9eee8;vertical-align:middle}.score-panel .score-lead{font-size:16px}.score-panel .score-caution{background:#fff5e6;border-left:4px solid #bd8028;padding:9px 12px;border-radius:4px}
  progress{width:100%;height:16px;accent-color:#087e6e}
  iframe{width:100%;height:760px;border:1px solid #dae5e7;border-radius:9px;background:white}
  @media(max-width:800px){.grid{grid-template-columns:1fr}.score-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}header{display:block}header nav{margin-top:9px}table{display:block;overflow-x:auto}}
`;

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]!);
}

function shell(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · 애드센스 채점기</title><style>${style}</style></head><body>
    <header><strong>애드센스 채점기 <small>2026.09.28</small></strong><nav><a href="/">작업 목록</a> &nbsp; <a href="/usage">사용법</a></nav></header><main>${body}</main>
    <script>${script}</script></body></html>`;
}

function dashboard(): string {
  return shell('작업 목록', `<h1>공개 사이트 검사</h1><p class="muted">관리자 PC에서만 실행합니다. 고객에게는 PDF 보고서만 전달하세요.</p>
  <div class="grid"><section class="card"><h2>새 검사</h2><form id="new-job">
    <label for="target">사이트 URL</label><input id="target" type="url" placeholder="https://example.com/" required>
    <label for="mode">검사 범위</label><select id="mode"><option value="quick">빠른 표본 검사 · 최대 20페이지</option><option value="standard" selected>기본 검사 · 최대 200페이지</option><option value="full">관리자 전체 검사 · 발견 가능한 공개 페이지</option></select>
    <label for="excluded">검사 제외 경로 (한 줄에 하나)</label><textarea id="excluded" placeholder="/private/&#10;/archive/"></textarea>
    <p class="muted">빠른 표본은 주요 페이지와 다양한 유형을 먼저 확인합니다. 상세한 검수가 필요하면 기본 200페이지 또는 전체 검사를 선택하세요. 모든 검사는 중단·재개할 수 있습니다.</p><p id="job-error" class="error"></p><button id="start-button">검사 시작</button>
  </form></section><section class="card"><h2>관리자 사용 순서</h2><p class="copybox">${esc(DOC)}</p><a class="button secondary" href="/usage">고객 안내문과 사용법</a></section></div>
  <section class="card"><h2>검사 작업</h2><div id="jobs">불러오는 중…</div></section>`, `
  const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function refresh(){const r=await fetch('/api/jobs');if(!r.ok)return;const jobs=await r.json();document.getElementById('jobs').innerHTML=jobs.length?'<table><thead><tr><th>사이트</th><th>범위</th><th>상태</th><th>발견 / 검사 / 실패</th><th>열기</th></tr></thead><tbody>'+jobs.map(j=>'<tr><td class="mono">'+escapeHtml(j.inputUrl)+'</td><td>'+ (j.mode==='full'?'전체':j.mode==='quick'?'빠른 20':'기본 200')+'</td><td>'+escapeHtml(j.status)+'</td><td>'+j.discoveredCount+' / '+j.inspectedCount+' / '+j.failedCount+'</td><td><a href="/jobs/'+encodeURIComponent(j.id)+'">상세</a></td></tr>').join('')+'</tbody></table>':'아직 작업이 없습니다.'}
  document.getElementById('new-job').addEventListener('submit',async e=>{e.preventDefault();const button=document.getElementById('start-button'),error=document.getElementById('job-error');button.disabled=true;error.textContent='';try{const r=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:document.getElementById('target').value,mode:document.getElementById('mode').value,excludedPaths:document.getElementById('excluded').value})});const data=await r.json();if(!r.ok)throw new Error(data.error);location.href='/jobs/'+data.id}catch(e){error.textContent=e.message||'실패했습니다.';button.disabled=false}});refresh();setInterval(refresh,5000);
  `);
}

function usage(): string {
  const boxes = [
    ['고객 공지·신청 안내', NOTICE_TEXT], ['기능과 이용 방법 답변', FEATURES_TEXT], ['코딩 AI에게 수정 요청', REPAIR_PROMPT_TEXT]
  ].map(([title, value], i) => `<section class="card"><h2>${esc(title)}</h2><div class="copybox" id="copy-${i}">${esc(value)}</div><p><button class="secondary" data-copy="copy-${i}">문구 복사</button></p></section>`).join('');
  return shell('사용법', `<h1>사용법</h1><section class="card"><h2>관리자 진행 순서</h2><div class="copybox">${esc(DOC)}</div></section>${boxes}
  <section class="card"><h2>검사 범위와 점수</h2><p>빠른 표본 검사는 최대 20페이지, 기본 검사는 최대 200페이지를 확인합니다. 각각 범위를 넘으면 표본 검사 점수로 표시합니다. 이 숫자는 Google의 승인 기준이 아닌 검수 비용 기준입니다. 보고서 첫 부분에는 100점 만점의 확인분 성적표와 비공식 승인 가능성 추정 지수, 다섯 영역 등급을 표시합니다. 점수는 직접 확인한 항목의 획득 E를 판정한 배점 W로 나눈 100 × E ÷ W입니다. 미확인 배점 U는 점수에 가정해 넣지 않고, 검증률 W/T와 가능한 점수 구간으로 별도 표시합니다. 직접 확인한 HTML·브라우저 본문이 없거나 측정된 배점 W가 0이면 숫자를 보류합니다. 이 지수는 실제 승인 확률이나 Google 심사 결과가 아닙니다.</p><p>전체 검사는 사이트맵과 내부 링크로 발견 가능한 공개 페이지만 대상으로 합니다. 확인 불가 항목과 계정·결제·표절 등 외부에서 확인할 수 없는 사항은 관리자 검토가 필요합니다.</p></section>`, `
    document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);b.textContent='복사됨';setTimeout(()=>b.textContent='문구 복사',1800)}));
  `);
}

function jobPage(id: string): string {
  return shell('검사 상세', `<h1>검사 상세</h1><div id="detail" class="card">불러오는 중…</div><section id="report-section" class="card" hidden><h2>보고서 미리보기</h2><iframe title="보고서 미리보기" id="report-frame"></iframe></section>`, `
    const id=${JSON.stringify(id)};const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const numberText=n=>Number.isFinite(n)?(Number.isInteger(n)?String(n):Number(n).toFixed(1)):'—';
    const grade=n=>n>=90?'A':n>=80?'B':n>=70?'C':n>=60?'D':'F';
    async function command(action){const r=await fetch('/api/jobs/'+id+'/'+action,{method:'POST'});const j=await r.json();if(!r.ok)return alert(j.error||'실패했습니다.');if(action==='recheck'&&j.id){location.href='/jobs/'+encodeURIComponent(j.id);return}refresh()}
    async function copyDelivery(){const r=await fetch('/api/jobs/'+id+'/delivery');const j=await r.json();if(!r.ok)return alert(j.error);await navigator.clipboard.writeText(j.text);const e=document.getElementById('copy-delivery');e.textContent='복사됨';setTimeout(()=>e.textContent='보고서 전달문 복사',1800)}
    let lastStatus='',progressSamples=[];async function refresh(){const r=await fetch('/api/jobs/'+id);if(!r.ok){document.getElementById('detail').textContent='작업을 찾을 수 없습니다.';return}const j=await r.json();if(j.status==='running'){if(!progressSamples.length||progressSamples.at(-1).count!==j.inspectedCount){progressSamples.push({count:j.inspectedCount,at:Date.now()});if(progressSamples.length>12)progressSamples.shift()}}else progressSamples=[];const status={'queued':'대기','running':'검사 중','paused':'일시 중지','cancelled':'취소됨','complete':'완료','failed':'실패'}[j.status]||j.status;let h='<p class="mono">'+escapeHtml(j.inputUrl)+'</p><div class="metrics"><div class="metric">발견<strong>'+j.discoveredCount+'</strong></div><div class="metric">검사<strong>'+j.inspectedCount+'</strong></div><div class="metric">실패<strong>'+j.failedCount+'</strong></div><div class="metric">대기<strong>'+j.pendingCount+'</strong></div></div><p>상태: <strong>'+status+'</strong> · 범위: '+(j.mode==='full'?'관리자 전체 검사':j.mode==='quick'?'빠른 표본 최대 20페이지':'기본 최대 200페이지')+'</p>';
      const target=j.mode==='quick'?Math.min(20,j.discoveredCount):j.mode==='standard'?Math.min(200,j.discoveredCount):j.discoveredCount;const percent=target?Math.min(100,Math.round(100*j.inspectedCount/target)):0;
      h+='<label for="scan-progress">진행률 '+percent+'% '+(j.mode==='full'?'(현재 발견 범위 기준)':'')+'</label><progress id="scan-progress" max="'+Math.max(1,target)+'" value="'+j.inspectedCount+'"></progress>';
      if(j.status==='running'&&progressSamples.length>=3&&target>j.inspectedCount){const first=progressSamples[0],last=progressSamples.at(-1),delta=last.count-first.count;if(delta>=2){const secondsPerPage=(last.at-first.at)/1000/delta;const remainingMinutes=Math.max(1,Math.round((target-j.inspectedCount)*secondsPerPage/60));const eta=remainingMinutes>=60?Math.floor(remainingMinutes/60)+'시간 '+remainingMinutes%60+'분':remainingMinutes+'분';h+='<p class="muted">최근 검사 속도 기준 남은 시간 약 '+eta+' · 사이트 응답과 추가 발견에 따라 달라집니다.</p>'}}
      if(j.error)h+='<p class="error">'+escapeHtml(j.error)+'</p>';
      if(j.mode==='standard'&&j.discoveredCount>200)h+='<p class="notice">해당 웹사이트는 페이지 수가 많아 기본 기준인 200페이지까지만 검수하여 채점했습니다. 전체 페이지 검수를 원하시면 관리자에게 문의해 주세요.</p>';
      if(j.mode==='quick'&&j.discoveredCount>20)h+='<p class="notice">빠른 표본 검사는 최대 20페이지만 검수합니다. 더 자세한 검수는 기본 200페이지 또는 관리자 전체 검사를 이용하세요.</p>';
      h+='<div class="row">';if(j.status==='running'||j.status==='queued')h+='<button class="secondary" data-command="pause">일시 중지</button><button class="danger" data-command="cancel">검사 취소</button>';
      if(j.status==='paused'||j.status==='failed')h+='<button data-command="resume">재개</button>';
      if(j.status!=='running'&&j.status!=='queued')h+='<button class="secondary" data-command="recheck">새로 재검사</button>';
      if(j.status==='complete')h+='<a class="button" href="/report/'+id+'/pdf">PDF 내보내기</a><a class="button secondary" href="/report/'+id+'/html">HTML 내보내기</a><a class="button secondary" href="/report/'+id+'/json">JSON 내보내기</a><button class="secondary" id="copy-delivery" onclick="copyDelivery()">보고서 전달문 복사</button>';
      if(j.status!=='queued')h+='<a class="button secondary" href="/report/'+id+'/evidence">ChatGPT용 직접 검증자료 JSON</a>';
      h+='</div>';
      if(j.status!=='queued')h+='<p><strong>직접 접속 확인 '+escapeHtml(j.directVerifiedCount)+'/'+escapeHtml(j.inspectedCount)+' URL</strong> · HTML 또는 실제 브라우저 본문 확인 수</p>';
      if(j.discoveryError||j.failureDiagnostics?.length){h+='<section class="score-panel"><h2>직접 접속 실패 원인과 재검사 방법</h2><p>검사 환경의 외부 네트워크 제한은 사이트 자체 오류로 단정하지 않습니다.</p>';
        if(j.discoveryError)h+='<p class="hold-reason"><strong>사이트 발견 단계</strong><br>'+escapeHtml(j.discoveryError)+'<br>'+escapeHtml(j.discoveryRetryAction||'검사 환경과 대상 URL을 확인한 뒤 재검사하세요.')+'</p>';
        if(j.failureDiagnostics?.length)h+='<ul>'+j.failureDiagnostics.map(f=>'<li><strong>'+escapeHtml(f.label)+' '+f.count+'건</strong> · '+escapeHtml(f.action)+'</li>').join('')+'</ul>';h+='</section>'}
      if(j.comparison){const c=j.comparison;h+='<section class="score-panel"><h2>이전 검사와 이번 검사</h2><p>이전 검사 <a href="/jobs/'+encodeURIComponent(c.previous.id)+'">'+escapeHtml(c.previous.id)+'</a> · '+escapeHtml(c.previous.startedAt||c.previous.createdAt)+'</p><p>이전 직접 확인 '+c.previous.directVerifiedCount+'/'+c.previous.attemptedUrlCount+' URL → 이번 '+c.current.directVerifiedCount+'/'+c.current.attemptedUrlCount+' URL</p><p>이전 점수 '+(c.previous.score===null?'평가 불가':escapeHtml(c.previous.score)+'/100점')+' → 이번 '+(c.current.score===null?'평가 불가':escapeHtml(c.current.score)+'/100점')+' · 두 점수 모두 현재 규칙으로 다시 계산해 비교합니다. 이전·이번 접속 기록은 별도 작업으로 보존됩니다.</p></section>'}
      if(j.score!==undefined){
        const held=j.score===null;
        const rate=j.verificationRate===null?'산출 불가':numberText(j.verificationRate)+'%';
        const interval=held?'산출 보류':j.possibleMin===null||j.possibleMax===null?'산출 불가':Number(j.possibleMin).toFixed(2)+'–'+Number(j.possibleMax).toFixed(2)+'/100점';
        const measured=numberText(j.measuredWeight),earned=numberText(j.earnedWeight),applicable=numberText(j.applicableWeight),unknown=numberText(j.unknownWeight);
        h+='<section class="score-panel"><h2>검사 범위의 확인분 성적표</h2>';
        h+='<div class="score-head'+(held?' hold':'')+'">'+(held?'평가 불가':escapeHtml(j.score)+'/100점 <span class="score-grade">'+grade(Number(j.score))+'등급</span>')+'</div>';
        if(!held)h+='<p class="score-lead"><strong>비공식 승인 가능성 추정 지수 '+escapeHtml(j.percentage)+'%</strong> · 실제 AdSense 승인 확률은 아닙니다.</p>';
        h+='<p><strong>직접 접속 검증 '+escapeHtml(j.directVerifiedCount)+' / '+escapeHtml(j.inspectedCount)+' URL</strong> · 원본 HTML 또는 본문이 있는 브라우저 화면을 확인한 수입니다.</p>';
        h+='<p><strong>확인된 항목 '+escapeHtml(earned)+' / '+escapeHtml(measured)+'점</strong> · 적용 가능한 배점 '+escapeHtml(applicable)+'점 중 '+escapeHtml(measured)+'점을 판정했습니다.</p>';
        if(held)h+='<p class="hold-reason"><strong>평가 불가 이유</strong><br>'+escapeHtml(j.holdReason||'채점할 근거를 확보하지 못했습니다.')+' 미확인 배점은 '+escapeHtml(unknown)+'점입니다.</p>';
        h+='<p><strong>검증률 '+escapeHtml(rate)+'</strong> · 가능한 총점의 수학적 범위 <strong>'+escapeHtml(interval)+'</strong></p>';
        if(!held)h+='<p class="score-caution">현재 점수는 실제 판정한 E '+escapeHtml(earned)+'점을 W '+escapeHtml(measured)+'점으로 나눈 100 × E ÷ W입니다. 미확인 U '+escapeHtml(unknown)+'점은 점수에 넣지 않았으며, 검증률이 낮으면 사이트 전체 판단도 제한됩니다. 핵심 미확인 규칙 '+escapeHtml((j.unmeasuredCoreRuleIds||[]).length)+'개는 보고서에서 확인하세요.'+(j.criticalCapApplied?' 공식 정책 중대 문제로 확인분 산식 원값 '+escapeHtml(j.rawEstimate)+'점에 39점 상한을 적용했습니다.':'')+'</p>';
        h+='<div class="score-metrics"><div><span>A · 해당 없음</span><strong>'+escapeHtml(numberText(j.nonApplicableWeight))+'</strong></div><div><span>T · 적용 가능</span><strong>'+escapeHtml(applicable)+'</strong></div><div><span>W · 검증 완료</span><strong>'+escapeHtml(measured)+'</strong></div><div><span>E · 획득</span><strong>'+escapeHtml(earned)+'</strong></div><div><span>U · 확인 불가</span><strong>'+escapeHtml(unknown)+'</strong></div></div>';
        h+='<p class="score-explain">가능한 총점 범위는 미확인 항목이 모두 0점 또는 모두 만점이라고 가정한 하한과 상한입니다. 승인 확률이나 통계적 신뢰구간이 아닙니다. 검증률은 사이트 전체 페이지가 아닌 적용 규칙 배점의 판정 비율입니다.</p></section><p class="muted">이전 저장 보고서에는 과거 채점 방식이 남아 있을 수 있습니다. 내보내기를 누르면 PDF·HTML·JSON을 현재 규칙으로 다시 생성합니다.</p>';
      }
      document.getElementById('detail').innerHTML=h;
      document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>command(button.dataset.command)));
      if(j.status==='complete'&&lastStatus!=='complete'){document.getElementById('report-section').hidden=false;document.getElementById('report-frame').src='/report/'+id}
      lastStatus=j.status;
    }refresh();setInterval(refresh,3000);
  `);
}

async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const item = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += item.length;
    if (size > 64 * 1024) throw new Error('요청이 너무 큽니다.');
    chunks.push(item);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('올바른 입력이 아닙니다.');
  return value as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, data: string | object, type = 'text/html; charset=utf-8'): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? type : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'" });
  res.end(text);
}

function localRequestAllowed(req: IncomingMessage): boolean {
  try {
    const host = new URL(`http://${req.headers.host || ''}`);
    if (!['127.0.0.1', 'localhost'].includes(host.hostname)) return false;
    if (req.method !== 'POST') return true;
    const origin = req.headers.origin;
    return !!origin && new URL(origin).host === host.host && new URL(origin).protocol === 'http:';
  } catch { return false; }
}

function exclusions(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split(/[\n,]/) : Array.isArray(value) ? value : [];
  if (raw.length > 100) throw new Error('제외 경로는 100개까지 입력할 수 있습니다.');
  return [...new Set(raw.map(x => String(x).trim()).filter(Boolean).map(x => {
    if (!x.startsWith('/') || x.startsWith('//') || x.includes('..') || /[?#]/.test(x)) throw new Error('제외 경로는 /로 시작하는 경로만 입력하세요.');
    return x;
  }))];
}

export function createApp(store = new Store()) {
  const runner = new JobRunner(store);
  const exportsInProgress = new Map<string, Promise<string | null>>();
  async function regenerateReport(id: string): Promise<string | null> {
    const existing = exportsInProgress.get(id);
    if (existing) return existing;
    const task = (async () => {
      const job = store.getJob(id);
      if (!job) throw new Error('작업을 찾을 수 없습니다.');
      const result = await exportReport(reportData(job), join(store.dir, 'reports', id));
      return result.pdfError;
    })();
    exportsInProgress.set(id, task);
    try { return await task; }
    finally { if (exportsInProgress.get(id) === task) exportsInProgress.delete(id); }
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const method = req.method || 'GET';
    try {
      if (!localRequestAllowed(req)) return send(res, 403, { error: '로컬 브라우저 요청만 허용됩니다.' });
      if (method === 'GET' && path === '/') return send(res, 200, dashboard());
      if (method === 'GET' && path === '/usage') return send(res, 200, usage());
      if (method === 'GET' && path === '/api/jobs') return send(res, 200, store.listSummaries());
      if (method === 'POST' && path === '/api/jobs') {
        const input = await bodyJson(req);
        if (typeof input.url !== 'string') throw new Error('사이트 URL을 입력하세요.');
        const url = normalizePageUrl(validateTargetSyntax(input.url).href);
        if (!url) throw new Error('공개 HTML 페이지 URL을 입력하세요.');
        const mode: ScanMode = input.mode === 'full' ? 'full' : input.mode === 'quick' ? 'quick' : 'standard';
        const excludedPaths = exclusions(input.excludedPaths);
        const root = new URL('/', url).toString();
        const job = store.createJob(url, root, mode, excludedPaths);
        store.enqueue(job.id, [url]);
        runner.start(job.id);
        return send(res, 201, { id: job.id });
      }
      const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(pause|resume|cancel|recheck|delivery))?$/);
      if (jobMatch) {
        const id = jobMatch[1], action = jobMatch[2];
        const summary = store.summary(id);
        if (!summary) return send(res, 404, { error: '작업을 찾을 수 없습니다.' });
        if (method === 'POST' && action === 'pause') { runner.pause(id); return send(res, 200, { ok: true }); }
        if (method === 'POST' && action === 'cancel') { runner.cancel(id); return send(res, 200, { ok: true }); }
        if (method === 'POST' && action === 'resume') { runner.start(id); return send(res, 200, { ok: true }); }
        if (method === 'POST' && action === 'recheck') {
          const original = store.getJob(id)!;
          const target = normalizePageUrl(validateTargetSyntax(original.inputUrl).href);
          if (!target) throw new Error('원래 URL이 공개 HTML 페이지가 아닙니다.');
          const rerun = store.createJob(target, original.rootUrl, original.mode, original.excludedPaths, id);
          store.enqueue(rerun.id, [target]);
          runner.start(rerun.id);
          return send(res, 201, { id: rerun.id, recheckOfJobId: id });
        }
        if (method === 'GET' && action === 'delivery') {
          if (summary.status !== 'complete') return send(res, 409, { error: '검사가 완료되지 않았습니다.' });
          return send(res, 200, { text: fillDeliveryText(reportData(store.getJob(id)!)) });
        }
        if (method === 'GET' && !action) {
          const job = store.getJob(id)!;
          const score = summary.status === 'complete' && job.signals ? reportData(job).score : undefined;
          const failureCounts = new Map<NonNullable<(typeof job.pages)[number]['failureCategory']>, number>();
          for (const page of job.pages) {
            const category = page.failureCategory ?? page.http?.failureCategory ?? page.desktopRender?.failureCategory
              ?? page.mobileRender?.failureCategory ?? (page.error ? 'unknown' : null);
            if (category) failureCounts.set(category, (failureCounts.get(category) ?? 0) + 1);
          }
          const failureDiagnostics = [...failureCounts].map(([category, count]) => ({
            category, count, label: failureLabel(category), action: retryAction(category),
          }));
          const previous = summary.recheckOfJobId ? store.getJob(summary.recheckOfJobId) : null;
          const previousScore = previous?.status === 'complete' && previous.signals ? reportData(previous).score.value : null;
          const comparison = previous ? {
            previous: { id: previous.id, createdAt: previous.createdAt, startedAt: previous.startedAt,
              attemptedUrlCount: previous.pages.length, directVerifiedCount: previous.pages.filter(hasDirectPageEvidence).length,
              score: previousScore },
            current: { id: job.id, createdAt: job.createdAt, startedAt: job.startedAt,
              attemptedUrlCount: job.pages.length, directVerifiedCount: job.pages.filter(hasDirectPageEvidence).length,
              score: score?.value ?? null },
          } : null;
          return send(res, 200, { ...summary, score: score?.value, percentage: score?.percentage,
            directVerifiedCount: job.pages.filter(hasDirectPageEvidence).length,
            discoveryError: job.signals?.discoveryError ?? null,
            discoveryFailureCategory: job.signals?.discoveryFailureCategory ?? null,
            discoveryRetryAction: retryAction(job.signals?.discoveryFailureCategory),
            failureDiagnostics,
            comparison,
            nonApplicableWeight: score?.nonApplicableWeight, applicableWeight: score?.applicableWeight,
            measuredWeight: score?.measuredWeight, earnedWeight: score?.earnedWeight, unknownWeight: score?.unknownWeight,
            verificationRate: score?.verificationRate, possibleMin: score?.possibleMin, possibleMax: score?.possibleMax,
            rawEstimate: score && score.measuredWeight > 0 ? Math.round(1000 * score.earnedWeight / score.measuredWeight) / 10 : null,
            criticalCapApplied: score?.criticalCapApplied,
            holdReason: score?.holdReason ? readableReason(score.holdReason) : score?.holdReason,
            unmeasuredCoreRuleIds: score?.unmeasuredCoreRuleIds });
        }
      }
      const pageMatch = path.match(/^\/jobs\/([a-f0-9-]{36})$/);
      if (method === 'GET' && pageMatch) return store.summary(pageMatch[1]) ? send(res, 200, jobPage(pageMatch[1])) : send(res, 404, '작업을 찾을 수 없습니다.');
      const evidenceMatch = path.match(/^\/report\/([a-f0-9-]{36})\/evidence$/);
      if (method === 'GET' && evidenceMatch) {
        const id = evidenceMatch[1];
        if (!store.summary(id)) return send(res, 404, { error: '작업을 찾을 수 없습니다.' });
        const job = store.getJob(id)!;
        const report = job.status === 'complete' && job.signals ? reportData(job) : null;
        const payload = Buffer.from(JSON.stringify(buildEvidenceBundle(job, report), null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="direct-evidence-${id}.json"`,
          'Content-Length': payload.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(payload);
      }
      const reportMatch = path.match(/^\/report\/([a-f0-9-]{36})(?:\/(pdf|html|json))?$/);
      if (method === 'GET' && reportMatch) {
        const id = reportMatch[1], format = reportMatch[2];
        const summary = store.summary(id);
        if (!summary) return send(res, 404, '작업을 찾을 수 없습니다.');
        if (summary.status !== 'complete') return send(res, 409, '검사가 완료되지 않았습니다.');
        if (!format) return send(res, 200, renderReport(reportData(store.getJob(id)!)));
        let pdfError: string | null;
        try { pdfError = await regenerateReport(id); }
        catch (error) {
          const detail = error instanceof Error ? error.message : '알 수 없는 오류';
          return send(res, 500, `보고서를 다시 생성하지 못했습니다: ${detail}`);
        }
        if (format === 'pdf' && pdfError) return send(res, 503, `PDF 생성용 브라우저를 사용할 수 없습니다: ${pdfError}. HTML·JSON 보고서와 직접 검증자료 JSON은 다운로드할 수 있습니다.`);
        const file = join(store.dir, 'reports', id, `report-${id}.${format}`);
        if (!existsSync(file)) return send(res, 500, '보고서를 다시 생성하지 못했습니다.');
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': format === 'pdf' ? 'application/pdf' : format === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit-${id}.${format}"`, 'Content-Length': data.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(data);
      }
      send(res, 404, method.startsWith('GET') ? '페이지를 찾을 수 없습니다.' : { error: '경로를 찾을 수 없습니다.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '알 수 없는 오류';
      send(res, 400, { error: message });
    }
  });
  return { server, store, runner };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || '4717');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 값이 올바르지 않습니다.');
  const app = createApp();
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`애드센스 채점기: http://127.0.0.1:${port}`);
    app.runner.resumeQueued();
  });
}
