import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const BOUNTY_API = "https://bounty.owockibot.xyz";
const PORT = parseInt(process.env.PORT || "3002", 10);

// ERC-8004 Reputation Registry on Base
const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

// Minimal ERC-8004 ABI for reading reputation data
const REPUTATION_ABI = parseAbi([
  "function getReputation(address agent) view returns (uint256)",
  "function getFeedback(address agent) view returns (tuple(address from, int8 score, string comment, uint256 timestamp)[])",
  "function getAgentCount() view returns (uint256)",
  "function getAgentByIndex(uint256 index) view returns (address)",
  "function totalReputation(address agent) view returns (uint256)",
]);

const viemClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

// --- Types ---

interface Bounty {
  id: string;
  title: string;
  description: string;
  status: string;
  reward: string;
  rewardFormatted: string;
  tags: string[];
  claimedBy?: string;
  createdAt?: string;
  completedAt?: string;
  payment?: { grossAmount?: string; grossReward?: string };
}

interface OnChainReputation {
  address: string;
  reputationScore: number;
  feedback: Array<{
    from: string;
    score: number;
    comment: string;
    timestamp: number;
  }>;
}

interface AgentProfile {
  address: string;
  onChainReputation: number;
  totalEarnings: number;
  bountiesCompleted: number;
  bountiesClaimed: number;
  successRate: number;
  tags: Record<string, number>;
  recentFeedback: Array<{
    from: string;
    score: number;
    comment: string;
    timestamp: number;
  }>;
  history: Array<{
    bountyId: string;
    title: string;
    reward: number;
    status: string;
    date: string;
  }>;
}

// --- ERC-8004 Contract Reads ---

async function fetchOnChainReputation(address: string): Promise<OnChainReputation> {
  try {
    // Try reading reputation score from the ERC-8004 registry
    const [reputation, feedback] = await Promise.allSettled([
      viemClient.readContract({
        address: REPUTATION_REGISTRY,
        abi: REPUTATION_ABI,
        functionName: "getReputation",
        args: [address as `0x${string}`],
      }),
      viemClient.readContract({
        address: REPUTATION_REGISTRY,
        abi: REPUTATION_ABI,
        functionName: "getFeedback",
        args: [address as `0x${string}`],
      }),
    ]);

    const repScore =
      reputation.status === "fulfilled" ? Number(reputation.value) : 0;

    const feedbackEntries: OnChainReputation["feedback"] = [];
    if (feedback.status === "fulfilled" && Array.isArray(feedback.value)) {
      for (const f of feedback.value) {
        feedbackEntries.push({
          from: String(f.from || ""),
          score: Number(f.score || 0),
          comment: String(f.comment || ""),
          timestamp: Number(f.timestamp || 0),
        });
      }
    }

    return { address, reputationScore: repScore, feedback: feedbackEntries };
  } catch {
    // Contract may not have data for this agent yet
    return { address, reputationScore: 0, feedback: [] };
  }
}

async function fetchAllOnChainAgents(): Promise<Map<string, OnChainReputation>> {
  const reputationMap = new Map<string, OnChainReputation>();

  try {
    // Try to enumerate agents from the registry
    const countResult = await viemClient
      .readContract({
        address: REPUTATION_REGISTRY,
        abi: REPUTATION_ABI,
        functionName: "getAgentCount",
      })
      .catch(() => 0n);

    const count = Number(countResult);
    if (count > 0) {
      const batchSize = Math.min(count, 50); // Cap to avoid huge reads
      const promises: Promise<void>[] = [];

      for (let i = 0; i < batchSize; i++) {
        promises.push(
          (async () => {
            try {
              const agentAddr = await viemClient.readContract({
                address: REPUTATION_REGISTRY,
                abi: REPUTATION_ABI,
                functionName: "getAgentByIndex",
                args: [BigInt(i)],
              });
              const rep = await fetchOnChainReputation(agentAddr);
              reputationMap.set(agentAddr.toLowerCase(), rep);
            } catch {
              // skip
            }
          })()
        );
      }
      await Promise.allSettled(promises);
    }
  } catch {
    // Contract may not support enumeration - that's fine, we'll look up individually
  }

  return reputationMap;
}

// --- Bounty API Aggregation ---

function aggregateAgents(
  bounties: Bounty[],
  onChainData: Map<string, OnChainReputation>
): AgentProfile[] {
  const agents = new Map<string, AgentProfile>();

  for (const b of bounties) {
    if (!b.claimedBy) continue;
    const addr = b.claimedBy;
    const addrLower = addr.toLowerCase();

    if (!agents.has(addrLower)) {
      const onChain = onChainData.get(addrLower);
      agents.set(addrLower, {
        address: addr,
        onChainReputation: onChain?.reputationScore || 0,
        totalEarnings: 0,
        bountiesCompleted: 0,
        bountiesClaimed: 0,
        successRate: 0,
        tags: {},
        recentFeedback: onChain?.feedback?.slice(-10) || [],
        history: [],
      });
    }

    const agent = agents.get(addrLower)!;
    agent.bountiesClaimed++;

    const reward =
      b.status === "completed" && b.payment
        ? Number(b.payment.grossAmount || b.payment.grossReward || 0) / 1e6
        : 0;

    if (b.status === "completed") {
      agent.bountiesCompleted++;
      agent.totalEarnings += reward;
    }

    for (const tag of b.tags || []) {
      agent.tags[tag] = (agent.tags[tag] || 0) + 1;
    }

    agent.history.push({
      bountyId: b.id,
      title: b.title || "Untitled",
      reward,
      status: b.status,
      date: b.createdAt || "",
    });
  }

  // Also add any on-chain agents not seen in bounty data
  for (const [addrLower, onChain] of onChainData) {
    if (!agents.has(addrLower)) {
      agents.set(addrLower, {
        address: onChain.address,
        onChainReputation: onChain.reputationScore,
        totalEarnings: 0,
        bountiesCompleted: 0,
        bountiesClaimed: 0,
        successRate: 0,
        tags: {},
        recentFeedback: onChain.feedback?.slice(-10) || [],
        history: [],
      });
    }
  }

  // Calculate rates
  for (const agent of agents.values()) {
    agent.successRate =
      agent.bountiesClaimed > 0
        ? Math.round((agent.bountiesCompleted / agent.bountiesClaimed) * 100)
        : 0;
  }

  // Sort by on-chain reputation first, then by earnings
  return [...agents.values()].sort(
    (a, b) => b.onChainReputation - a.onChainReputation || b.totalEarnings - a.totalEarnings
  );
}

// --- Helpers ---

function shortAddr(a: string): string {
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "Unknown";
}

// --- Cache ---
let cachedAgents: AgentProfile[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

async function getAgents(): Promise<AgentProfile[]> {
  if (cachedAgents && Date.now() - cacheTime < CACHE_TTL) return cachedAgents;

  const [bountiesRes, onChainData] = await Promise.allSettled([
    fetch(`${BOUNTY_API}/bounties`).then((r) => r.json() as Promise<Bounty[]>),
    fetchAllOnChainAgents(),
  ]);

  const bounties =
    bountiesRes.status === "fulfilled"
      ? bountiesRes.value.filter((b: Bounty) => b.title)
      : [];
  const onChain =
    onChainData.status === "fulfilled"
      ? onChainData.value
      : new Map<string, OnChainReputation>();

  // For agents from bounty data, also fetch their individual on-chain reputation
  const uniqueAddresses = new Set(
    bounties.filter((b: Bounty) => b.claimedBy).map((b: Bounty) => b.claimedBy!.toLowerCase())
  );
  const fetchPromises: Promise<void>[] = [];
  for (const addr of uniqueAddresses) {
    if (!onChain.has(addr)) {
      fetchPromises.push(
        fetchOnChainReputation(addr).then((rep) => {
          if (rep.reputationScore > 0 || rep.feedback.length > 0) {
            onChain.set(addr, rep);
          }
        })
      );
    }
  }
  await Promise.allSettled(fetchPromises);

  cachedAgents = aggregateAgents(bounties, onChain);
  cacheTime = Date.now();
  return cachedAgents;
}

// --- Server ---

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/agents") {
      try {
        const agents = await getAgents();
        return Response.json(agents, {
          headers: { "Cache-Control": "public, max-age=60" },
        });
      } catch {
        return Response.json({ error: "API error" }, { status: 502 });
      }
    }

    if (url.pathname.startsWith("/api/agent/")) {
      const addr = url.pathname.split("/api/agent/")[1];
      try {
        const agents = await getAgents();
        const agent = agents.find(
          (a) => a.address.toLowerCase() === addr.toLowerCase()
        );
        if (!agent)
          return Response.json({ error: "Agent not found" }, { status: 404 });
        return Response.json(agent, {
          headers: { "Cache-Control": "public, max-age=60" },
        });
      } catch {
        return Response.json({ error: "API error" }, { status: 502 });
      }
    }

    // On-chain reputation lookup for any address
    if (url.pathname.startsWith("/api/reputation/")) {
      const addr = url.pathname.split("/api/reputation/")[1];
      try {
        const rep = await fetchOnChainReputation(addr);
        return Response.json(rep);
      } catch {
        return Response.json({ error: "Contract read failed" }, { status: 502 });
      }
    }

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        registry: REPUTATION_REGISTRY,
        chain: "base",
      });
    }

    if (url.pathname.startsWith("/agent/")) {
      return new Response(PROFILE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Reputation Dashboard running on http://localhost:${PORT}`);
console.log(`ERC-8004 Registry: ${REPUTATION_REGISTRY} on Base`);

// --- HTML Templates ---

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Reputation Dashboard — ERC-8004</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root { --bg: #0a0b10; --card: #12141f; --card-hover: #1a1d2e; --border: #1e2235; --text: #e0e0e0; --muted: #8890a4; --accent: #6366f1; --accent2: #8b5cf6; --green: #22c55e; --yellow: #eab308; --red: #ef4444; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .header { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%); padding: 40px 24px; text-align: center; border-bottom: 1px solid var(--border); }
  .header h1 { font-size: 32px; font-weight: 700; color: white; margin-bottom: 8px; }
  .header p { color: rgba(255,255,255,0.7); font-size: 16px; }
  .header .registry { font-family: monospace; font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 8px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; text-align: center; transition: transform 0.2s; }
  .stat-card:hover { transform: translateY(-2px); border-color: var(--accent); }
  .stat-card .value { font-size: 36px; font-weight: 700; }
  .stat-card .label { font-size: 13px; color: var(--muted); margin-top: 4px; text-transform: uppercase; }
  .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
  .chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  .chart-card h3 { font-size: 15px; color: var(--muted); margin-bottom: 16px; }
  .leaderboard { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 32px; }
  .leaderboard-header { padding: 16px 24px; border-bottom: 1px solid var(--border); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 12px 20px; color: var(--muted); font-size: 12px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
  td { padding: 14px 20px; border-bottom: 1px solid var(--border); font-size: 14px; }
  tr:hover { background: var(--card-hover); }
  .rank { font-weight: 700; color: var(--accent); }
  .rank-1 { color: #fbbf24; }
  .rank-2 { color: #9ca3af; }
  .rank-3 { color: #cd7f32; }
  .addr-link { color: var(--accent2); text-decoration: none; font-family: monospace; font-size: 13px; }
  .addr-link:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 100px; font-size: 12px; }
  .badge-high { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-med { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .badge-low { background: rgba(239,68,68,0.15); color: var(--red); }
  .earnings { font-weight: 600; color: var(--green); }
  .rep-score { font-weight: 600; color: var(--accent); font-family: monospace; }
  .tag { display: inline-block; background: rgba(99,102,241,0.15); color: var(--accent); padding: 2px 8px; border-radius: 100px; font-size: 11px; margin: 1px; }
  .feedback-section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 32px; }
  .feedback-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
  .feedback-item:last-child { border-bottom: none; }
  .feedback-score { font-weight: 600; }
  .feedback-score.positive { color: var(--green); }
  .feedback-score.negative { color: var(--red); }
  @media (max-width: 768px) { .charts-grid { grid-template-columns: 1fr; } .header h1 { font-size: 24px; } }
</style>
</head>
<body>
<div class="header">
  <h1>Agent Reputation Dashboard</h1>
  <p>On-chain reputation scores from the ERC-8004 Reputation Registry on Base</p>
  <div class="registry">Registry: ${REPUTATION_REGISTRY}</div>
</div>
<div class="container">
  <div class="stats-row" id="globalStats"></div>
  <div class="charts-grid">
    <div class="chart-card"><h3>Top Agents by On-Chain Reputation</h3><canvas id="repChart"></canvas></div>
    <div class="chart-card"><h3>Success Rate Distribution</h3><canvas id="successChart"></canvas></div>
    <div class="chart-card"><h3>Earnings vs Reputation</h3><canvas id="scatterChart"></canvas></div>
    <div class="chart-card"><h3>Bounties by Status</h3><canvas id="statusChart"></canvas></div>
  </div>
  <div class="leaderboard">
    <div class="leaderboard-header">Top-Rated Agents (sorted by on-chain reputation)</div>
    <table>
      <thead><tr><th>Rank</th><th>Agent ID</th><th>On-Chain Rep</th><th>Earnings</th><th>Completed</th><th>Success Rate</th><th>Recent Feedback</th></tr></thead>
      <tbody id="leaderboard"></tbody>
    </table>
  </div>
  <div class="feedback-section">
    <h3 style="margin-bottom:16px;color:var(--muted);">Recent On-Chain Feedback</h3>
    <div id="recentFeedback"><p style="color:var(--muted)">Loading...</p></div>
  </div>
</div>
<script>
let repChart, successChart, scatterChart, statusChart;
function shortAddr(a) { return a ? a.slice(0,6)+'...'+a.slice(-4) : '?'; }
function rateBadge(r) {
  if (r >= 75) return '<span class="badge badge-high">'+r+'%</span>';
  if (r >= 50) return '<span class="badge badge-med">'+r+'%</span>';
  return '<span class="badge badge-low">'+r+'%</span>';
}
async function load() {
  const res = await fetch('/api/agents');
  const agents = await res.json();
  const totalAgents = agents.length;
  const totalCompleted = agents.reduce((s,a)=>s+a.bountiesCompleted,0);
  const totalEarnings = agents.reduce((s,a)=>s+a.totalEarnings,0);
  const totalRep = agents.reduce((s,a)=>s+a.onChainReputation,0);
  const avgRate = totalAgents>0 ? Math.round(agents.reduce((s,a)=>s+a.successRate,0)/totalAgents) : 0;

  document.getElementById('globalStats').innerHTML = [
    {v:totalAgents,l:'Active Agents',c:'#6366f1'},
    {v:totalRep,l:'Total On-Chain Rep',c:'#8b5cf6'},
    {v:totalEarnings.toFixed(0)+' USDC',l:'Total Distributed',c:'#22c55e'},
    {v:avgRate+'%',l:'Avg Success Rate',c:'#eab308'},
  ].map(s=>'<div class="stat-card"><div class="value" style="color:'+s.c+'">'+s.v+'</div><div class="label">'+s.l+'</div></div>').join('');

  const top8 = agents.slice(0,8);
  if(repChart)repChart.destroy();
  repChart = new Chart(document.getElementById('repChart'),{type:'bar',data:{labels:top8.map(a=>shortAddr(a.address)),datasets:[{label:'Reputation',data:top8.map(a=>a.onChainReputation),backgroundColor:'#8b5cf6',borderRadius:6}]},options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#888'},grid:{color:'#1e2235'}},y:{ticks:{color:'#aaa'},grid:{display:false}}}}});

  const brackets={'90-100%':0,'70-89%':0,'50-69%':0,'25-49%':0,'0-24%':0};
  agents.forEach(a=>{if(a.successRate>=90)brackets['90-100%']++;else if(a.successRate>=70)brackets['70-89%']++;else if(a.successRate>=50)brackets['50-69%']++;else if(a.successRate>=25)brackets['25-49%']++;else brackets['0-24%']++;});
  if(successChart)successChart.destroy();
  successChart = new Chart(document.getElementById('successChart'),{type:'doughnut',data:{labels:Object.keys(brackets),datasets:[{data:Object.values(brackets),backgroundColor:['#22c55e','#84cc16','#eab308','#f97316','#ef4444']}]},options:{plugins:{legend:{labels:{color:'#aaa'}}}}});

  if(scatterChart)scatterChart.destroy();
  scatterChart = new Chart(document.getElementById('scatterChart'),{type:'scatter',data:{datasets:[{label:'Agents',data:agents.filter(a=>a.totalEarnings>0||a.onChainReputation>0).map(a=>({x:a.totalEarnings,y:a.onChainReputation})),backgroundColor:'#6366f1',pointRadius:6}]},options:{scales:{x:{title:{display:true,text:'Earnings (USDC)',color:'#888'},ticks:{color:'#888'},grid:{color:'#1e2235'}},y:{title:{display:true,text:'On-Chain Reputation',color:'#888'},ticks:{color:'#888'},grid:{color:'#1e2235'}}},plugins:{legend:{display:false}}}});

  const sts={completed:0,claimed:0,submitted:0,other:0};
  agents.forEach(a=>a.history.forEach(h=>{sts[h.status]?sts[h.status]++:sts.other++;}));
  if(statusChart)statusChart.destroy();
  statusChart = new Chart(document.getElementById('statusChart'),{type:'pie',data:{labels:['Completed','Claimed','Submitted','Other'],datasets:[{data:[sts.completed,sts.claimed,sts.submitted,sts.other],backgroundColor:['#22c55e','#eab308','#3b82f6','#6b7280']}]},options:{plugins:{legend:{labels:{color:'#aaa'}}}}});

  const rows = agents.slice(0,25).map((a,i)=>{
    const rankClass=i<3?' rank-'+(i+1):'';
    const feedbackCount = a.recentFeedback ? a.recentFeedback.length : 0;
    const feedbackBadge = feedbackCount > 0 ? '<span class="badge badge-high">'+feedbackCount+' entries</span>' : '<span style="color:var(--muted)">none</span>';
    return '<tr onclick="location.href=\\'/agent/'+a.address+'\\'" style="cursor:pointer"><td class="rank'+rankClass+'">#'+(i+1)+'</td><td><a class="addr-link" href="/agent/'+a.address+'">'+shortAddr(a.address)+'</a></td><td class="rep-score">'+a.onChainReputation+'</td><td class="earnings">'+a.totalEarnings.toFixed(2)+' USDC</td><td>'+a.bountiesCompleted+'</td><td>'+rateBadge(a.successRate)+'</td><td>'+feedbackBadge+'</td></tr>';
  }).join('');
  document.getElementById('leaderboard').innerHTML=rows||'<tr><td colspan="7" style="text-align:center;color:#666;">No agents found</td></tr>';

  // Recent feedback across all agents
  const allFeedback = agents.flatMap(a=>(a.recentFeedback||[]).map(f=>({...f,agent:a.address}))).sort((a,b)=>b.timestamp-a.timestamp).slice(0,10);
  if(allFeedback.length>0){
    document.getElementById('recentFeedback').innerHTML=allFeedback.map(f=>'<div class="feedback-item"><span class="feedback-score '+(f.score>0?'positive':'negative')+'">'+(f.score>0?'+':'')+f.score+'</span> to <span style="font-family:monospace;color:var(--accent2)">'+shortAddr(f.agent)+'</span> from '+shortAddr(f.from)+(f.comment?' — <em>'+f.comment+'</em>':'')+'</div>').join('');
  } else {
    document.getElementById('recentFeedback').innerHTML='<p style="color:var(--muted)">No on-chain feedback recorded yet. Feedback will appear here as agents receive reputation entries on the ERC-8004 registry.</p>';
  }
}
load();
setInterval(load,300000);
</script>
</body>
</html>`;

const PROFILE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Profile — ERC-8004 Reputation</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root { --bg: #0a0b10; --card: #12141f; --border: #1e2235; --text: #e0e0e0; --muted: #8890a4; --accent: #6366f1; --accent2: #8b5cf6; --green: #22c55e; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .back { display: inline-block; padding: 12px 24px; color: var(--accent); text-decoration: none; font-size: 14px; }
  .back:hover { text-decoration: underline; }
  .profile-header { padding: 32px 24px; max-width: 1000px; margin: 0 auto; }
  .profile-header h1 { font-size: 24px; font-weight: 700; font-family: monospace; word-break: break-all; }
  .profile-header .sub { color: var(--muted); margin-top: 4px; }
  .container { max-width: 1000px; margin: 0 auto; padding: 0 24px 24px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
  .stat-card .value { font-size: 32px; font-weight: 700; }
  .stat-card .label { font-size: 12px; color: var(--muted); margin-top: 4px; text-transform: uppercase; }
  .chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .chart-card h3 { font-size: 15px; color: var(--muted); margin-bottom: 12px; }
  .section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 24px; }
  .section h3 { padding: 16px 20px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 15px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 16px; color: var(--muted); font-size: 12px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
  td { padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; }
  .badge-completed { background: rgba(34,197,94,0.15); color: #22c55e; }
  .badge-claimed { background: rgba(234,179,8,0.15); color: #eab308; }
  .badge-submitted { background: rgba(59,130,246,0.15); color: #3b82f6; }
  .tag { display: inline-block; background: rgba(99,102,241,0.15); color: var(--accent); padding: 2px 8px; border-radius: 100px; font-size: 11px; margin: 1px; }
  .feedback-item { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .feedback-item:last-child { border-bottom: none; }
  .feedback-score { font-weight: 600; }
  .feedback-score.positive { color: var(--green); }
  .feedback-score.negative { color: #ef4444; }
</style>
</head>
<body>
<a class="back" href="/">Back to Leaderboard</a>
<div class="profile-header">
  <h1 id="address">Loading...</h1>
  <div class="sub" id="subtitle"></div>
</div>
<div class="container">
  <div class="stats-row" id="stats"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;">
    <div class="chart-card"><h3>Bounty Outcomes</h3><canvas id="outcomeChart"></canvas></div>
    <div class="chart-card"><h3>Tags Worked On</h3><canvas id="tagChart"></canvas></div>
  </div>
  <div class="section" id="feedbackSection" style="display:none">
    <h3>On-Chain Feedback (ERC-8004)</h3>
    <div id="feedbackList"></div>
  </div>
  <div class="section">
    <h3>Bounty History</h3>
    <table><thead><tr><th>Bounty</th><th>Title</th><th>Reward</th><th>Status</th></tr></thead><tbody id="history"></tbody></table>
  </div>
</div>
<script>
async function load() {
  const addr = window.location.pathname.split('/agent/')[1];
  if (!addr) return;
  const res = await fetch('/api/agent/' + addr);
  if (!res.ok) { document.getElementById('address').textContent = 'Agent not found'; return; }
  const a = await res.json();
  document.title = 'Agent ' + addr.slice(0,8) + '...';
  document.getElementById('address').textContent = a.address;
  document.getElementById('subtitle').textContent = 'On-chain reputation: ' + a.onChainReputation + ' | ' + a.bountiesCompleted + ' bounties completed';

  document.getElementById('stats').innerHTML = [
    {v:a.onChainReputation,l:'On-Chain Reputation',c:'#8b5cf6'},
    {v:a.totalEarnings.toFixed(2)+' USDC',l:'Total Earnings',c:'#22c55e'},
    {v:a.bountiesCompleted,l:'Completed',c:'#6366f1'},
    {v:a.successRate+'%',l:'Success Rate',c:'#eab308'},
  ].map(s=>'<div class="stat-card"><div class="value" style="color:'+s.c+'">'+s.v+'</div><div class="label">'+s.l+'</div></div>').join('');

  const outcomes={completed:0,claimed:0,submitted:0,other:0};
  a.history.forEach(h=>{outcomes[h.status]?outcomes[h.status]++:outcomes.other++;});
  new Chart(document.getElementById('outcomeChart'),{type:'doughnut',data:{labels:Object.keys(outcomes),datasets:[{data:Object.values(outcomes),backgroundColor:['#22c55e','#eab308','#3b82f6','#6b7280']}]},options:{plugins:{legend:{labels:{color:'#aaa'}}}}});

  const sortedTags=Object.entries(a.tags).sort((x,y)=>y[1]-x[1]).slice(0,8);
  new Chart(document.getElementById('tagChart'),{type:'bar',data:{labels:sortedTags.map(t=>t[0]),datasets:[{data:sortedTags.map(t=>t[1]),backgroundColor:'#8b5cf6',borderRadius:4}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#888'}},y:{ticks:{color:'#888'},beginAtZero:true}}}});

  if (a.recentFeedback && a.recentFeedback.length > 0) {
    document.getElementById('feedbackSection').style.display = 'block';
    document.getElementById('feedbackList').innerHTML = a.recentFeedback.map(f =>
      '<div class="feedback-item"><span class="feedback-score '+(f.score>0?'positive':'negative')+'">'+(f.score>0?'+':'')+f.score+'</span> from <span style="font-family:monospace;color:var(--accent2)">'+(f.from?f.from.slice(0,8)+'...':'unknown')+'</span>'+(f.comment?' — <em>'+f.comment+'</em>':'')+'</div>'
    ).join('');
  }

  document.getElementById('history').innerHTML = a.history.map(h =>
    '<tr><td>#'+h.bountyId+'</td><td>'+h.title+'</td><td>'+(h.reward>0?h.reward.toFixed(2)+' USDC':'--')+'</td><td><span class="badge badge-'+h.status+'">'+h.status+'</span></td></tr>'
  ).join('');
}
load();
</script>
</body>
</html>`;
