import os
import subprocess
import unittest
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parents[1] / "launch-worker-sandbox.sh"
SENTINEL = "ONLY_A_FAKE_NEGATIVE_TEST_VALUE"

class LauncherRejectsOverrides(unittest.TestCase):
    def invoke(self, args, additions=None):
        env = {"PATH": "/usr/bin:/bin", "HOME": "/root", **(additions or {})}
        return subprocess.run([str(LAUNCHER), *args], env=env, text=True, capture_output=True, timeout=10)

    def test_untrusted_docker_flags_are_rejected_as_extra_arguments(self):
        for flag in ("--mount=type=bind,src=/,dst=/host", "--network=host", "--privileged", "--env=OPENAI_API_KEY=x"):
            with self.subTest(flag=flag):
                result = self.invoke(["orloom-worker-negative-test", flag])
                self.assertEqual(result.returncode, 64)
                self.assertIn("options and command overrides are not accepted", result.stderr)
                self.assertNotIn(SENTINEL, result.stdout + result.stderr)

    def test_docker_options_cannot_be_used_as_the_container_name(self):
        for name in ("--mount", "--network=host", "--privileged", "--env"):
            with self.subTest(name=name):
                result = self.invoke([name])
                self.assertEqual(result.returncode, 64)
                self.assertIn("invalid sandbox name", result.stderr)

    def test_credential_and_daemon_environment_is_rejected_without_echoing_value(self):
        for variable in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "ORLOOM_WORKER_TOKEN", "ORLOOM_DATABASE_URL", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY", "DEPLOY_PRIVATE_KEY", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"):
            with self.subTest(variable=variable):
                result = self.invoke(["orloom-worker-negative-test"], {variable: SENTINEL})
                self.assertEqual(result.returncode, 65)
                self.assertIn(variable, result.stderr)
                self.assertNotIn(SENTINEL, result.stdout + result.stderr)

if __name__ == "__main__":
    unittest.main()
