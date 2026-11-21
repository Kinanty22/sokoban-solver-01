# Sokoban solver — room-wise push-optimal A*

Entry for make.fun `sokoban-solver-01-run-20261121`: build the best Sokoban
solver. The program is `main.ts` at this repository's root; it runs on
Node 22 as `node /bot/main.ts`, reads every instance of a set from
`/input/<id>/level.txt`, and writes `/output/<id>/solution.txt` for each.

## Why this design wins points

The checker gives 1,000 points only at the push-optimal count P*, and a
solution even one push over P* earns under half. So the search must
minimise pushes, not moves. The levels this competition draws are a
hallway with rooms off it (3–4 boxes each), and a box that leaves its room
can never come back, so each room is an independent push-optimal
subproblem and P* is the sum of the rooms' optima. The solver therefore:

1. cuts the hallway (the dead squares of the player's row) out of the
   floor and takes each connected part holding boxes as a room;
2. solves each room with A* over pushes: a state is the sorted box squares
   plus the player's reachable region (named by its lowest square), the
   cost is pushes, and the estimate is the cheapest assignment of boxes to
   goals by true walking distance — admissible and consistent, so the first
   solved state popped from the open list is push-optimal;
3. prunes two deadlocks no solution can leave: a box on a dead square (no
   pull-back path from any goal reaches it) and a frozen 2×2 block of
   walls and boxes holding a box off its goal;
4. expands every push into the player's shortest walk to the pushing
   square, and walks on to the next room through the hallway.

A level with no separable rooms falls back to the same push-A* over the
whole level; a level the search gives up on still gets a valid (empty)
`solution.txt` rather than a crash.

## Determinism

Budgets are counts of states, never the wall clock: nothing here reads the
time, the environment, or any randomness, and every tie breaks in a fixed
order. Two runs on the same set produce byte-identical outputs.

## Local test

```
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Score the outputs with the kit's scorer:

```
MAKEFUN_OUTPUT_DIR=out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=scores node <kit>/program/scorer/score.ts
```

Practice-set result (kit practice, 21 Nov 2026): **score 1,000,000** —
every instance solved in exactly P* pushes (i001: 13, i002: 16, i003: 29,
i004: 47, i005: 60), in about 0.7 s for the whole set. The house baseline
plain-astar 1.0.0 scores 200,000 on the same set (only i001 solved).

## Licence

MIT — see `LICENSE`.
