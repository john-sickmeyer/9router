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

    def test_api_identity_and_pool_policy_survive_updates(self):
        self.state['openaiPool'] = {'enabled': True, 'accounts': [{'id': 'api-account', 'provider': 'openai'}]}
        for model in self.models:
            if model['id'].startswith('cx/'): model['id'] = model['id'][3:]
        baseline = self.check()
        self.assertEqual(len(baseline), 3)
        self.state['openaiPool']['accounts'][0]['id'] = 'different-api-account'
        with self.assertRaisesRegex(RuntimeError, 'identities'): self.check(baseline)
        self.state['openaiPool']['accounts'][0]['id'] = 'api-account'
        self.state['openaiPool']['enabled'] = False
        for model in self.models:
            if model['id'].startswith('gpt-'): model['id'] = 'cx/' + model['id']
        with self.assertRaisesRegex(RuntimeError, 'disabled'): self.check(baseline)

    def test_preserves_kimi_catalog_and_all_account_identities(self):
        self.state['kimiModels'] = ['moonshot/kimi-k3.1-pro', 'moonshot/kimi-k3.1-pro-highspeed']
        self.models += [{'id': model} for model in self.state['kimiModels']]
        self.state['connectionIdentities'] = self.state['accounts'] + [{'id': 'kimi-account', 'provider': 'moonshot'}]
        baseline = self.check()
        self.assertEqual(len(baseline), 3)
        self.models.pop()
        with self.assertRaisesRegex(RuntimeError, 'catalog'): self.check(baseline)


if __name__ == '__main__': unittest.main()
