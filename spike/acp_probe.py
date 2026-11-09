#!/usr/bin/env python3
"""最小 ACP 探针：启动 agy acp，握手、建会话、发一条提示，打印全部消息。
用法: acp_probe.py <cwd> <prompt> [agy acp 额外参数...]
"""
import json, subprocess, sys, threading, time

cwd, prompt, extra = sys.argv[1], sys.argv[2], sys.argv[3:]
proc = subprocess.Popen(["agy", "acp", *extra], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True, bufsize=1)
pending, nid, lock = {}, [0], threading.Lock()

def send(obj):
    line = json.dumps(obj)
    print(">>", line[:400], flush=True)
    proc.stdin.write(line + "\n"); proc.stdin.flush()

def call(method, params, timeout=300):
    with lock:
        nid[0] += 1; i = nid[0]
        ev = threading.Event(); pending[i] = [ev, None]
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    if not ev.wait(timeout):
        raise TimeoutError(method)
    return pending.pop(i)[1]

def reader():
    for line in proc.stdout:
        line = line.strip()
        if not line: continue
        try: msg = json.loads(line)
        except Exception: print("?? ", line[:300], flush=True); continue
        if "method" in msg and "id" in msg:  # agent -> client 请求
            print("<<REQ", line[:600], flush=True)
            if msg["method"] == "session/request_permission":
                opts = msg["params"].get("options", [])
                pick = next((o for o in opts if o.get("kind", "").startswith("allow")), opts[0] if opts else None)
                send({"jsonrpc": "2.0", "id": msg["id"],
                      "result": {"outcome": {"outcome": "selected", "optionId": pick["optionId"]}}})
            else:
                send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "not supported"}})
        elif "method" in msg:  # 通知
            u = msg.get("params", {}).get("update", {})
            kind = u.get("sessionUpdate")
            if kind == "agent_message_chunk":
                print(u.get("content", {}).get("text", ""), end="", flush=True)
            else:
                print("\n<<NTF", line[:300], flush=True)
        else:
            print("\n<<RES", line[:1500], flush=True)
            if msg.get("id") in pending:
                pending[msg["id"]][1] = msg; pending[msg["id"]][0].set()

def err_reader():
    for line in proc.stderr:
        print("[stderr]", line.rstrip()[:300], flush=True)

threading.Thread(target=reader, daemon=True).start()
threading.Thread(target=err_reader, daemon=True).start()

t0 = time.time()
init = call("initialize", {"protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}}, 60)
new = call("session/new", {"cwd": cwd, "mcpServers": []}, 60)
if "error" in new:
    print("session/new 失败"); proc.kill(); sys.exit(2)
sid = new["result"]["sessionId"]
res = call("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]}, 600)
print(f"\n== 完成，用时 {time.time()-t0:.1f}s", flush=True)
proc.terminate()
