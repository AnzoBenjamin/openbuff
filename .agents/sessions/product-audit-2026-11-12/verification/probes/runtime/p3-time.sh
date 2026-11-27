#!/usr/bin/env bash
# usage: p3-time.sh label cmd...
label=$1; shift
ts=()
for i in 1 2 3 4 5; do
  s=$(date +%s%N); "$@" >/tmp/verify-runtime/p3-last.out 2>&1; ec=$?; e=$(date +%s%N)
  ts+=($(( (e-s)/1000000 )))
done
sorted=$(printf '%s\n' "${ts[@]}" | sort -n | tr '\n' ' ')
med=$(printf '%s\n' "${ts[@]}" | sort -n | sed -n 3p)
echo "$label: runs(ms)=${ts[*]} sorted=$sorted median=${med}ms lastExit=$ec firstLine=$(head -c 80 /tmp/verify-runtime/p3-last.out | head -1)"
