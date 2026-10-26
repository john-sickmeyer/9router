import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts'))
from studio_health import CODEX, CLAUDE, SPEEDS, EFFORTS, catalog_contract, live_contract


class HealthTest(unittest.TestCase):
    def setUp(self):
        effort = {level: {'supported': True} for level in EFFORTS}
        self.models = [{'id': f'cx/{model}@{speed}'} for model in CODEX for speed in SPEEDS]
        self.models += [{'id': f'cc/{model}', 'capabilities': {'effort': copy.deepcopy(effort)}} for model in CLAUDE]
        self.state = {'choices': [
            {'id': f'{prefix}/{model}', 'efforts': EFFORTS, 'speeds': ['standard']}
            for prefix, models in [('cx', CODEX), ('cc', CLAUDE)] for model in models],
            'accounts': [{'id': 'codex-account', 'provider': 'codex'}, {'id': 'claude-account', 'provider': 'claude'}]}

    def check(self, baseline=None):
        return live_contract(self.state, json.dumps({'data': self.models}), baseline)

    def test_valid_contract_accepts_temporarily_stale_speed_eligibility(self):
        self.assertEqual(len(self.check()), 2)

    def test_removed_or_duplicate_alias_is_rejected(self):
        self.models[-1] = self.models[0]
        with self.assertRaisesRegex(RuntimeError, 'catalog'): self.check()

    def test_lost_claude_effort_is_rejected(self):
        self.models[-1]['capabilities']['effort']['max']['supported'] = False
        with self.assertRaisesRegex(RuntimeError, 'effort'): self.check()

    def test_accidentally_enabled_claude_fast_is_rejected(self):
        self.state['choices'][-1]['speeds'].append('fast')
        with self.assertRaisesRegex(RuntimeError, 'disabled'): self.check()

    def test_lost_account_is_rejected(self):
        baseline = self.check()
        self.state['accounts'].pop()
        with self.assertRaisesRegex(RuntimeError, 'identities'): self.check(baseline)


if __name__ == '__main__': unittest.main()
