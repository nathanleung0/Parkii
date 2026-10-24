"""Unit tests with a FAKE Elastic transport (development fixtures only). They prove the adapter's
logic and authorization checks; they do NOT prove the real Elastic Agent Builder path works.
Agent conversation search remains disabled until server-enforced scope is implemented."""
import json
import unittest

from agents.providers.provider_common import ProviderError
from agents.providers.retrieval import ElasticConfig, ElasticRetrieval, SearchScope
from agents.providers.retrieval.elastic import TOOL_USER, TOOL_WORKSPACE

COLS = [{"name": n} for n in ("user_id", "workspace_id", "kind", "source_id", "checkpoint_id", "url",
                              "title", "content", "content_hash", "retrieved_at", "_score")]


def row(user="u1", ws="w1", kind="source", sid="s1", cid=None, content="Hydrometallurgy costs less energy.",
        title="Recycling costs", score=1.5):
    return [user, ws, kind, sid, cid, "https://example.com/a", title, content, "abc", "2026-10-24T12:00:00Z", score]


def esql(*rows):
    return {"results": [{"type": "esql_results", "data": {"columns": COLS, "values": list(rows)}}]}


class FakeElastic:
    def __init__(self, execute=None, converse=None, put=(201, {"result": "created"}),
                 setup_status=201, delete=(200, {"deleted": 2})):
        self.calls, self.execute, self.converse = [], execute, converse
        self.put, self.setup_status, self.delete = put, setup_status, delete

    def __call__(self, method, url, headers, body, timeout):
        payload = json.loads(body) if body else None
        self.calls.append((method, url, headers, payload))
        if url.endswith("/tools/_execute"):
            return 200, self.execute
        if url.endswith("/converse"):
            return 200, self.converse
        if "/_delete_by_query" in url:
            return self.delete
        if method == "PUT" and "/_doc/" in url:
            return self.put
        return self.setup_status, {}


def svc(fake):
    cfg = ElasticConfig("https://kb.example", "https://es.example", "secret-key")
    return ElasticRetrieval(cfg, fake)


class SearchTests(unittest.TestCase):
    def test_direct_search_executes_scoped_tool_with_trusted_user_id(self):
        fake = FakeElastic(execute=esql(row()))
        res = svc(fake).search_sources("battery costs", SearchScope("u1"))
        method, url, headers, payload = fake.calls[0]
        self.assertTrue(url.endswith("/api/agent_builder/tools/_execute"))
        self.assertEqual(payload["tool_id"], TOOL_USER)
        self.assertEqual(payload["tool_params"], {"user_id": "u1", "query": "battery costs"})
        self.assertEqual(headers["kbn-xsrf"], "true")
        self.assertEqual(headers["Authorization"], "ApiKey secret-key")
        self.assertEqual(res.hits[0]["sourceId"], "s1")
        self.assertEqual(res.trace["mode"], "tool_execute")

    def test_workspace_scope_uses_workspace_tool(self):
        fake = FakeElastic(execute=esql(row()))
        svc(fake).search_sources("x", SearchScope("u1", "w1"))
        self.assertEqual(fake.calls[0][3]["tool_id"], TOOL_WORKSPACE)
        self.assertEqual(fake.calls[0][3]["tool_params"]["workspace_id"], "w1")

    def test_rows_for_other_users_or_workspaces_are_dropped(self):
        fake = FakeElastic(execute=esql(row(user="u1"), row(user="intruder", sid="leak"),
                                        row(ws="other-ws", sid="leak2")))
        res = svc(fake).search_sources("x", SearchScope("u1", "w1"))
        self.assertEqual([h["sourceId"] for h in res.hits], ["s1"])
        self.assertEqual(res.trace["droppedForAuthorization"], 2)

    def test_agent_path_is_blocked_before_any_unscoped_model_or_tool_call(self):
        converse = {"conversation_id": "c1", "steps": [
            {"type": "tool_call", "tool_id": TOOL_USER, "params": {"user_id": "intruder", "query": "x"},
             "results": esql(row(user="intruder", sid="leak"), row(user="u1", sid="mine"))}],
            "response": {"message": "done"}}
        fake = FakeElastic(converse=converse)
        with self.assertRaises(ProviderError) as cm:
            svc(fake).search_sources("x", SearchScope("u1"), via_agent=True)
        self.assertEqual(cm.exception.code, "FORBIDDEN")
        self.assertEqual(fake.calls, [])

    def test_hits_capped_at_five_and_excerpt_at_500(self):
        long = ("filler " * 300) + "lithium cobalt recovery " + ("filler " * 300)
        fake = FakeElastic(execute=esql(*[row(sid=f"s{i}", content=long) for i in range(9)]))
        res = svc(fake).search_sources("lithium cobalt recovery", SearchScope("u1"))
        self.assertEqual(len(res.hits), 5)
        self.assertLessEqual(len(res.hits[0]["excerpt"]), 500)
        self.assertIn("lithium", res.hits[0]["excerpt"])

    def test_invalid_input_is_rejected(self):
        s = svc(FakeElastic())
        for q, scope in [("", SearchScope("u1")), ("x" * 2001, SearchScope("u1")), ("ok", SearchScope(""))]:
            with self.assertRaises(ProviderError) as cm:
                s.search_sources(q, scope)
            self.assertEqual(cm.exception.code, "VALIDATION_ERROR")

    def test_http_error_is_typed_and_hides_key(self):
        s = svc(lambda *a: (401, {"error": {"reason": "secret-key PRIVATE_ARTICLE"}}))
        with self.assertRaises(ProviderError) as cm:
            s.search_sources("x", SearchScope("u1"))
        self.assertEqual(cm.exception.code, "UNAUTHORIZED")
        self.assertNotIn("secret-key", str(cm.exception))
        self.assertNotIn("PRIVATE_ARTICLE", str(cm.exception))


class IndexTests(unittest.TestCase):
    SOURCE = {"id": "s1", "url": "https://example.com/a", "title": "T", "text": "body text",
              "availability": "ready", "retrievedAt": "2026-10-24T12:00:00Z", "contentHash": "h"}

    def test_requires_explicit_consent(self):
        fake = FakeElastic()
        for consent in (False, None, "yes"):
            with self.assertRaises(ProviderError) as cm:
                svc(fake).index_source(self.SOURCE, user_id="u1", workspace_id="w1", consent=consent)
            self.assertEqual(cm.exception.code, "FORBIDDEN")
        self.assertEqual(fake.calls, [])

    def test_source_indexed_with_owner_and_opt_in_and_idempotent_id(self):
        fake = FakeElastic()
        rec = svc(fake).index_source(self.SOURCE, user_id="u1", workspace_id="w1", consent=True)
        self.assertEqual((rec.doc_id, rec.status), ("source:s1", "ready"))
        method, url, _, doc = fake.calls[0]
        self.assertEqual(method, "PUT")
        self.assertIn("/_doc/source:s1", url)
        self.assertEqual((doc["user_id"], doc["workspace_id"], doc["opted_in"]), ("u1", "w1", True))

    def test_unavailable_source_is_not_indexed(self):
        with self.assertRaises(ProviderError):
            svc(FakeElastic()).index_source({"id": "s", "url": "u", "title": "t", "availability": "unavailable"},
                                            user_id="u1", workspace_id="w1", consent=True)

    def test_checkpoint_indexes_note_summary_and_labeled_next_step_only(self):
        fake = FakeElastic()
        cp = {"id": "c1", "taskId": "w1", "userNote": "Compare costs next",
              "summary": [{"text": "Read two recycling articles", "sourceIds": ["s1"], "basis": "observed"}],
              "proposedNextStep": {"text": "Build cost table", "sourceIds": [], "basis": "inferred"},
              "resourceSnapshots": [{"title": "Notes - Untitled.txt"}]}
        rec = svc(fake).index_checkpoint(cp, user_id="u1", consent=True)
        content = fake.calls[0][3]["content"]
        self.assertEqual(rec.doc_id, "checkpoint:c1")
        self.assertIn("User note: Compare costs next", content)
        self.assertIn("Proposed next step (inferred)", content)
        self.assertNotIn("Untitled.txt", content)

    def test_index_failure_is_reported_not_raised(self):
        rec = svc(FakeElastic(put=(503, {"error": "unavailable"}))).index_source(
            self.SOURCE, user_id="u1", workspace_id="w1", consent=True)
        self.assertEqual(rec.status, "failed")
        self.assertEqual(rec.error["code"], "INTERNAL_ERROR")

    def test_delete_projection_is_scoped_to_owner(self):
        fake = FakeElastic()
        out = svc(fake).delete_projection(user_id="u1", checkpoint_id="c1")
        self.assertEqual(out["deleted"], 2)
        filters = fake.calls[0][3]["query"]["bool"]["filter"]
        self.assertIn({"term": {"user_id": "u1"}}, filters)
        self.assertIn({"term": {"checkpoint_id": "c1"}}, filters)
        with self.assertRaises(ProviderError):
            svc(fake).delete_projection(user_id="u1")


class SetupTests(unittest.TestCase):
    def test_setup_creates_index_two_tools_and_agent(self):
        fake = FakeElastic()
        out = svc(fake).ensure_setup()
        urls = [c[1] for c in fake.calls]
        self.assertEqual(sum(u.endswith("/api/agent_builder/tools") for u in urls), 2)
        self.assertTrue(any(u.endswith("/api/agent_builder/agents") for u in urls))
        self.assertEqual(out["agent"], "created")
        tool_bodies = [c[3] for c in fake.calls if c[1].endswith("/api/agent_builder/tools")]
        for body in tool_bodies:
            self.assertIn("user_id == ?user_id", body["configuration"]["query"])
            self.assertIn("opted_in == true", body["configuration"]["query"])
            self.assertIn("LIMIT 5", body["configuration"]["query"])

    def test_setup_tolerates_existing_resources(self):
        fake = lambda *a: (409, {"error": "resource already exists"})
        self.assertEqual(svc(fake).ensure_setup()["agent"], "exists")


if __name__ == "__main__":
    unittest.main()
