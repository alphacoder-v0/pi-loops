# autoresearch — one experiment per run, a ledger, held-out evidence before promotion

The shape is the one Karpathy's autoresearch and Arbor made familiar: a **research contract** a
person writes (objective, metric, which files may change, which are protected, dev and held-out
commands, a promotion rule), a **ledger** of every attempt including the failed ones, an isolated
worktree per experiment, and a rule that the held-out number decides — never the dev number a run
was tuning against. What pi-loops adds is that nothing here needs a kernel: the contract and the
ledger are files in the repository, each run is one stateful loop run, and the checker of
`--verify` is the evaluator that re-measures before a promotion reaches you.

| file | what it is |
|---|---|
| [recipe.toml](recipe.toml) | one job, `every 1h`, `--verify`, 40-minute timeout |
| [experiment.md](experiment.md) | the playbook: contract → ledger → one hypothesis → worktree → measure → row → maybe promote |
| [RESEARCH.template.md](RESEARCH.template.md) | copy to the project root as `RESEARCH.md` and fill in; the loop stops until it exists |
| [example/](example/) | a filled-in contract with a naive exact k-NN in pure Python: `bash eval.sh dev` prints `metric=<speedup>` |

Try it on the example first:

```sh
cp -r .agents/skills/autoresearch/example /tmp/knn && cd /tmp/knn && git init -q && git add -A && git commit -qm "baseline"
pi            # then: /recipe add autoresearch   and   /cron run autoresearch
```

The first run measures the baseline and writes `results.tsv`; the next ones each try one idea.
Under `propose` a promotable branch arrives in `/inbox` with both numbers; under `act` it is
merged into the checkout and the finding says so.
