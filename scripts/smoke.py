#!/usr/bin/env python3
"""端到端冒烟测试：核验/成环/原子发布/快照不可变/授权变更重算/依据过期/日期校验"""
import json, urllib.request, urllib.error, subprocess, sys

BASE = "http://localhost:3100/api"

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "{}")

PASS, FAIL = 0, 0
def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ✓ {name}")
    else:
        FAIL += 1; print(f"  ✗ {name}  {detail}")

# 1. 演示草稿包：预期不合格（配乐授权 6 月底到期）
s, r = call("POST", "/packages/1/verify", {})
check("演示包核验执行", s == 200 and r["valid"])
check("演示包不合格(配乐不覆盖全年)", not r["qualified"] and
      any(f["materialId"] == 4 and f["reason"] == "NOT_COVERING" for f in r["failures"]))
f4 = [f for f in r["failures"] if f["materialId"] == 4][0]
check("不合格节点给出名称来源路径",
      any(p[-1] == "配乐《晨间旋律》" and p[0].startswith("数字化互动展项") for p in f4["namePaths"]),
      json.dumps(f4["namePaths"], ensure_ascii=False))
check("缺授权不得发布", call("POST", "/packages/1/publish", {"basisVersion": r["basisVersion"]})[0] == 422)

# 2. 非法日期（保存使用范围与核验两个环节均应拒绝）
s, r = call("PUT", "/packages/1", {"name": "x", "medium": "展厅大屏", "region": "中国大陆",
                                   "start_date": "2026-13-99", "end_date": "2026-01-01"})
check("非法日期在保存范围时被拒绝", s == 400 and any("日期" in e for e in r["errors"]), r)
s, r = call("PUT", "/packages/1", {"name": "x", "medium": "展厅大屏", "region": "中国大陆",
                                   "start_date": "2026-12-31", "end_date": "2026-01-01"})
check("起止倒置被拒绝", s == 400 and any("晚于" in e for e in r["errors"]), r)

# 3. 成环检测：新增 互动展项(1) -> 油画(2)，而 2 已是 1 的上游
s, r = call("POST", "/edges", {"source_id": 1, "target_id": 2})
check("成环关系被拒绝", s == 400 and "成环" in r["errors"][0], r)

# 4. 延长配乐授权 → 重新核验合格 → 发布成功（原子快照）
s, auths = call("GET", "/authorizations")
music = [a for a in auths if a["material_id"] == 4 and not a["revoked"]][0]
basis_before = call("GET", "/basis")[1]["basisVersion"]
s, r = call("PUT", f"/authorizations/{music['id']}",
            {**music, "end_date": "2027-12-31", "revoked": False})
check("授权更新成功", s == 200)
basis_after = call("GET", "/basis")[1]["basisVersion"]
check("授权变更使依据版本+1", basis_after == basis_before + 1, f"{basis_before}->{basis_after}")

s, r = call("POST", "/packages/1/verify", {})
check("延长后核验合格", r["valid"] and r["qualified"])
s, pub = call("POST", "/packages/1/publish", {"basisVersion": r["basisVersion"]})
check("发布成功", s == 201 and pub["snapshotId"], pub)
snap_id = pub.get("snapshotId")
s, pkg = call("GET", "/packages/1")
check("包状态=已发布", pkg["status"] == "published")

# 5. 快照不可变：读取快照内容
s, snap = call("GET", f"/snapshots/{snap_id}")
check("快照含素材清单与全部节点", snap["qualified"] and
      len(snap["payload"]["materials"]) == 2 and
      len(snap["payload"]["nodes"]) == 5, json.dumps([n["name"] for n in snap["payload"]["nodes"]], ensure_ascii=False))

# 6. 已发布包不可编辑清单/范围
s, r = call("PUT", "/packages/1/items", {"material_ids": [1]})
check("已发布包清单冻结", s == 409)

# 7. 撤销配乐授权 → 已发布包自动转 needs_review，原快照保留
s, r = call("POST", f"/authorizations/{music['id']}/revoke", {})
check("撤销触发重算", s == 200)
s, pkg = call("GET", "/packages/1")
check("已发布包→需复核", pkg["status"] == "needs_review")
check("原快照仍保留", len(pkg["snapshots"]) == 1 and pkg["snapshots"][0]["id"] == snap_id)
s, snap2 = call("GET", f"/snapshots/{snap_id}")
check("原快照内容未被改动", snap2["payload"]["verified_at"] == snap["payload"]["verified_at"])

# 8. 用第二个已发布包验证 needs_review → 人工复核再发布
#    包1恢复授权后也应保持 needs_review（不自动翻回已发布）
s, r = call("PUT", f"/authorizations/{music['id']}",
            {**music, "end_date": "2027-12-31", "revoked": False})
s, pkg = call("GET", "/packages/1")
check("资格恢复后包1仍为需复核(等待人工发布)", pkg["status"] == "needs_review", pkg["status"])
vr = call("POST", "/packages/1/verify", {})[1]
call("POST", "/packages/1/publish", {"basisVersion": vr["basisVersion"]})

#    包2：只含油画(2)，其授权为 *，单独建一份展厅大屏授权以便撤销
s, a2 = call("POST", "/authorizations", {"material_id": 2, "licensor": "本馆-复核测试",
                                         "medium": "展厅大屏", "region": "中国大陆",
                                         "start_date": "2025-01-01", "end_date": "2030-12-31"})
s, pk2 = call("POST", "/packages", {"name": "复核测试包"})
call("PUT", f"/packages/{pk2['id']}", {"name": "复核测试包", "medium": "展厅大屏", "region": "中国大陆",
                                       "start_date": "2026-01-01", "end_date": "2026-12-31"})
call("PUT", f"/packages/{pk2['id']}/items", {"material_ids": [2]})
vr = call("POST", f"/packages/{pk2['id']}/verify", {})[1]
call("POST", f"/packages/{pk2['id']}/publish", {"basisVersion": vr["basisVersion"]})
# 撤销油画的全部授权 → 包2 降级需复核
wild = [a for a in call("GET", "/authorizations")[1]
        if a["material_id"] == 2 and a["medium"] == "*"][0]
call("POST", f"/authorizations/{wild['id']}/revoke", {})
call("POST", f"/authorizations/{a2['id']}/revoke", {})
s, pkg2 = call("GET", f"/packages/{pk2['id']}")
check("第二包→需复核", pkg2["status"] == "needs_review")
s, snap_before = call("GET", f"/snapshots/{pkg2['snapshots'][0]['id']}")
# 不合格时拒绝发布
vr = call("POST", f"/packages/{pk2['id']}/verify", {})[1]
check("复核不合格仍拒绝发布", call("POST", f"/packages/{pk2['id']}/publish",
                                   {"basisVersion": vr["basisVersion"]})[0] == 422)
# 恢复一份授权
call("PUT", f"/authorizations/{a2['id']}", {"material_id": 2, "licensor": "本馆-复核测试",
                                            "medium": "展厅大屏", "region": "中国大陆",
                                            "start_date": "2025-01-01", "end_date": "2030-12-31",
                                            "revoked": False, "document": None})
# 包仍处于 needs_review（不会在资格恢复时自动翻成已发布，须人工复核再发布）
s, pkg2 = call("GET", f"/packages/{pk2['id']}")
check("资格恢复后仍需人工复核", pkg2["status"] == "needs_review", pkg2["status"])
vr = call("POST", f"/packages/{pk2['id']}/verify", {})[1]
first_snap = pkg2["snapshots"][0]["id"]
s, pub2 = call("POST", f"/packages/{pk2['id']}/publish", {"basisVersion": vr["basisVersion"]})
check("复核合格后再发布生成新快照", s == 201 and pub2["snapshotId"] != first_snap, pub2)
s, pkg2 = call("GET", f"/packages/{pk2['id']}")
check("两份快照均保留", len(pkg2["snapshots"]) == 2)
s, snap_old = call("GET", f"/snapshots/{first_snap}")
check("旧快照内容未变", snap_old["payload"]["verified_at"] == snap_before["payload"]["verified_at"])

# 9. 依据过期：拿旧 basisVersion 发布 → 409（用独立草稿包）
s, pk3 = call("POST", "/packages", {"name": "并发冲突测试包"})
call("PUT", f"/packages/{pk3['id']}", {"name": "并发冲突测试包", "medium": "展厅大屏", "region": "中国大陆",
                                       "start_date": "2026-01-01", "end_date": "2026-12-31"})
call("PUT", f"/packages/{pk3['id']}/items", {"material_ids": [2]})  # 油画有*授权
s, vr = call("POST", f"/packages/{pk3['id']}/verify", {})
# 制造一次无关变更（新建素材）使版本递增
call("POST", "/materials", {"name": "临时素材-依据过期测试"})
s, r = call("POST", f"/packages/{pk3['id']}/publish", {"basisVersion": vr["basisVersion"]})
check("依据过期发布被拒绝(409)", s == 409 and "过期" in r["errors"][0], r)
# 重新核验后可正常发布
s, vr2 = call("POST", f"/packages/{pk3['id']}/verify", {})
s, p3 = call("POST", f"/packages/{pk3['id']}/publish", {"basisVersion": vr2["basisVersion"]})
check("过期后重新核验可发布", s == 201 and p3["snapshotId"])
# 已发布后再次发布应被状态守卫拒绝（而非产生重复快照）
s, r = call("POST", f"/packages/{pk3['id']}/publish", {"basisVersion": vr2["basisVersion"]})
check("已发布包重复发布被拒绝", s == 409 and "已发布" in r["errors"][0], r)

# 10. 自环 / 重复关系
check("自环被拒绝", call("POST", "/edges", {"source_id": 2, "target_id": 2})[0] == 400)
check("重复关系被拒绝", call("POST", "/edges", {"source_id": 2, "target_id": 1})[0] == 409)

# 11. 空清单 / 无使用范围的草稿
s, p = call("POST", "/packages", {"name": "空草稿"})
pid = p["id"]
s, r = call("PUT", f"/packages/{pid}/items", {"material_ids": []})
check("空清单被拒绝", s == 400)
call("PUT", f"/packages/{pid}", {"name": "空草稿", "medium": "展厅大屏", "region": "中国大陆",
                                 "start_date": "2026-01-01", "end_date": "2026-12-31"})
s, r = call("POST", f"/packages/{pid}/verify", {})
check("无素材核验报错", not r["valid"] and any("素材" in e for e in r["errors"]), r)
check("草稿可删除", call("DELETE", f"/packages/{pid}")[0] == 200)
check("已发布包不可删除", call("DELETE", "/packages/1")[0] == 409)

# 12. 撤销是唯一授权时的原因 ALL_REVOKED
s, mat = call("POST", "/materials", {"name": "孤立素材X"})
mid = mat["id"]
s, a = call("POST", "/authorizations", {"material_id": mid, "licensor": "L", "medium": "*", "region": "*",
                                        "start_date": "2025-01-01", "end_date": "2030-01-01"})
call("POST", f"/authorizations/{a['id']}/revoke", {})
s, pk = call("POST", "/packages", {"name": "孤立测试包"})
call("PUT", f"/packages/{pk['id']}", {"name": "孤立测试包", "medium": "展厅大屏", "region": "中国大陆",
                                      "start_date": "2026-01-01", "end_date": "2026-12-31"})
call("PUT", f"/packages/{pk['id']}/items", {"material_ids": [mid]})
s, vr = call("POST", f"/packages/{pk['id']}/verify", {})
check("全部撤销原因=ALL_REVOKED", any(f["materialId"] == mid and f["reason"] == "ALL_REVOKED" for f in vr["failures"]))

print(f"\n结果: {PASS} 通过, {FAIL} 失败")
sys.exit(1 if FAIL else 0)
