#!/usr/bin/env python3
"""M0 探针：权限请求字段（一律拒绝并记录原文）与 session/load 续聊。
用法:
  acp_probe2.py perm <cwd> <prompt>             发一轮，拒绝所有权限请求，打印请求原文
  acp_probe2.py turn <cwd> <prompt>             新会话发一轮，打印 sessionId 后退出进程
  acp_probe2.py load <cwd> <sessionId> <prompt> 新进程中 session/load 后再发一轮
环境变量 HOME 决定账号。
"""
import json, subprocess, sys, threading, time

mode, cwd = sys.argv[1], sys.argv[2]
proc = subprocess.Popen(["agy", "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, text=True, bufsize=1)
pending, nid, lock, text = {}, [0], threading.Lock(), []

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n"); proc.stdin.flush()

def call(method, params, timeout=300):
    with lock:
        nid[0] += 1; i = nid[0]; ev = threading.Event(); pending[i] = [ev, None]
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    if not ev.wait(timeout): raise TimeoutError(method)
    return pending.pop(i)[1]

def reader():
    for line in proc.stdout:
        try: msg = json.loads(line)
        except Exception: continue
        if "method" in msg and "id" in msg:
            if msg["method"] == "session/request_permission":
                print("== PERMISSION REQUEST ==\n" + json.dumps(msg["params"], ensure_ascii=False, indent=1), flush=True)
                opts = msg["params"].get("options", [])
                pick = next((o for o in opts if o.get("kind") == "reject_once"), None) or \
                       next((o for o in opts if o.get("kind", "").startswith("reject")), None)
                outcome = {"outcome": "selected", "optionId": pick["optionId"]} if pick else {"outcome": "cancelled"}
                send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": outcome}})
            else:
                print("== OTHER REQUEST", msg["method"], flush=True)
                send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "not supported"}})
        elif "method" in msg:
            u = msg.get("params", {}).get("update", {})
            k = u.get("sessionUpdate")
            if k == "agent_message_chunk": text.append(u.get("content", {}).get("text", ""))
            elif k in ("tool_call", "tool_call_update") and mode == "perm":
                print("-- update", json.dumps(u, ensure_ascii=False)[:500], flush=True)
        elif msg.get("id") in pending:
            pending[msg["id"]][1] = msg; pending[msg["id"]][0].set()

threading.Thread(target=reader, daemon=True).start()
call("initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}}, 60)
if mode == "load":
    sid, prompt = sys.argv[3], sys.argv[4]
    r = call("session/load", {"sessionId": sid, "cwd": cwd, "mcpServers": []}, 120)
    print("session/load ->", json.dumps(r, ensure_ascii=False)[:300]); text.clear()
else:
    prompt = sys.argv[3]
    r = call("session/new", {"cwd": cwd, "mcpServers": []}, 60)
    sid = r["result"]["sessionId"]
    print("sessionId =", sid)
t0 = time.time()
r = call("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]}, 600)
print("stop =", json.dumps(r.get("result") or r.get("error"), ensure_ascii=False)[:300])
print("reply =", "".join(text).strip()[:800])
print(f"elapsed = {time.time()-t0:.1f}s")
proc.terminate()
