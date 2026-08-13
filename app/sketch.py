"""A mergeable, bounded-error latency sketch.

Percentiles cannot be averaged. A dashboard that stores "P95 per hour" and means
them across a week reports a number with no defined relationship to the real
P95 - usually optimistic, because the hour that actually hurt is diluted by 167
quiet ones. The only correct ways to answer a 30-day P95 are to sort every
sample (measured at ~4 s for 1.1M turns, which is not a dashboard) or to keep a
mergeable summary of the distribution.

This is DDSketch: values are bucketed on a logarithmic scale, so every reported
quantile is within RELATIVE_ERROR of the true value *relative to that value*.
A 3,000 ms P95 is accurate to about +/-30 ms at 1% - far tighter than the
run-to-run variation of the thing being measured - and the guarantee holds at
both ends of the distribution, which a fixed-width histogram cannot do.

The tradeoff is stated wherever a sketch-derived number is shown: the API marks
those values `exact: false` and carries the error bound, and short ranges are
answered exactly from the raw rows instead.
"""

from __future__ import annotations

import math
import struct
from typing import Iterable

# 1% relative error. Chosen so a 200 ms first-token P95 is accurate to +/-2 ms
# and a 10 s outlier to +/-100 ms, while keeping a populated sketch to a few
# hundred buckets - small enough to store one per hour per agent.
RELATIVE_ERROR = 0.01
GAMMA = (1 + RELATIVE_ERROR) / (1 - RELATIVE_ERROR)
LOG_GAMMA = math.log(GAMMA)
# Sub-millisecond timings are noise in a voice pipeline; collapsing them into a
# single bucket keeps the index space bounded without losing anything real.
MIN_VALUE = 1.0
# The bucket index of a value depends on GAMMA, so a blob written under one
# relative error is meaningless under another. The magic carries both a layout
# version and the error bound (in tenths of a percent) so a changed constant is
# detected instead of silently mis-merged; `aggregate.ensure_schema` rebuilds
# every rollup when the tag moves.
_LAYOUT_VERSION = 1
_MAGIC = b"DS" + struct.pack("<BB", _LAYOUT_VERSION, round(RELATIVE_ERROR * 1000))
# Derived from the magic itself rather than restated, so there is no way to
# change the on-disk shape without moving the tag that triggers the rebuild.
FORMAT_TAG = _MAGIC.hex()


class SketchFormatError(ValueError):
    """A stored blob was not written by this build of the sketch.

    Raised rather than swallowed: `aggregate.ensure_schema` deletes the whole
    rollup tier whenever the format tag moves, so a blob that survives to a read
    is either corruption or a bug. Returning an empty sketch instead would
    publish "no data" for a metric that has plenty, or - worse, during a partial
    rebuild - a percentile computed from whichever hours happened to be
    readable.
    """


class Sketch:
    __slots__ = ("buckets", "count", "total", "minimum", "maximum", "zeros")

    def __init__(self) -> None:
        self.buckets: dict[int, int] = {}
        self.count = 0
        self.total = 0.0
        self.minimum: float | None = None
        self.maximum: float | None = None
        # Values below MIN_VALUE are counted, not bucketed, so a 0 ms
        # measurement still contributes to count and to the median's rank.
        self.zeros = 0

    def add(self, value: float, weight: int = 1) -> None:
        # A negative span is a mismeasurement, and `metrics.distribution` drops
        # it from the exact path. Dropping it here too keeps the two paths
        # counting the same population; treating it as a zero would inflate the
        # sketch's count and pull its median down where the exact path had
        # neither.
        if value is None or weight <= 0 or value < 0:
            return
        value = float(value)
        self.count += weight
        self.total += value * weight
        self.minimum = value if self.minimum is None else min(self.minimum, value)
        self.maximum = value if self.maximum is None else max(self.maximum, value)
        if value < MIN_VALUE:
            self.zeros += weight
            return
        index = math.ceil(math.log(value) / LOG_GAMMA)
        self.buckets[index] = self.buckets.get(index, 0) + weight

    def merge(self, other: "Sketch") -> "Sketch":
        for index, weight in other.buckets.items():
            self.buckets[index] = self.buckets.get(index, 0) + weight
        self.count += other.count
        self.total += other.total
        self.zeros += other.zeros
        if other.minimum is not None:
            self.minimum = other.minimum if self.minimum is None else min(self.minimum, other.minimum)
        if other.maximum is not None:
            self.maximum = other.maximum if self.maximum is None else max(self.maximum, other.maximum)
        return self

    def quantile(self, fraction: float) -> float | None:
        """Nearest-rank quantile, matching `app.metrics.percentile`.

        The rank is chosen identically to the exact path so that narrowing a time
        range - which switches the dashboard from sketch to exact - does not
        move the number by more than the stated error bound.
        """
        if not self.count:
            return None
        rank = max(1, min(self.count, math.ceil(round(fraction * self.count, 9))))
        if rank <= self.zeros:
            return 0.0
        remaining = rank - self.zeros
        for index in sorted(self.buckets):
            remaining -= self.buckets[index]
            if remaining <= 0:
                # Bucket midpoint in log space: the value whose relative distance
                # to both bucket edges is equal, which is what bounds the error.
                return 2 * (GAMMA ** index) / (GAMMA + 1)
        return self.maximum

    def encode(self) -> bytes:
        parts = [_MAGIC, struct.pack("<qdddq", self.count, self.total,
                                     self.minimum if self.minimum is not None else math.nan,
                                     self.maximum if self.maximum is not None else math.nan,
                                     self.zeros)]
        for index in sorted(self.buckets):
            parts.append(struct.pack("<iq", index, self.buckets[index]))
        return b"".join(parts)

    @classmethod
    def decode(cls, blob: bytes | None) -> "Sketch":
        sketch = cls()
        if not blob:
            return sketch
        if len(blob) < 4 + 40 or blob[:4] != _MAGIC:
            raise SketchFormatError(
                f"sketch blob header {blob[:4]!r} was not written by format {FORMAT_TAG}"
            )
        sketch.count, sketch.total, minimum, maximum, sketch.zeros = struct.unpack("<qdddq", blob[4:44])
        sketch.minimum = None if math.isnan(minimum) else minimum
        sketch.maximum = None if math.isnan(maximum) else maximum
        for offset in range(44, len(blob), 12):
            index, weight = struct.unpack("<iq", blob[offset:offset + 12])
            sketch.buckets[index] = sketch.buckets.get(index, 0) + weight
        return sketch

    @classmethod
    def of(cls, values: Iterable[float]) -> "Sketch":
        sketch = cls()
        for value in values:
            if value is not None:
                sketch.add(value)
        return sketch

    def summary(self) -> dict[str, object]:
        """The same shape `app.metrics.distribution` returns, marked inexact."""
        from app.metrics import MIN_SAMPLE_P50, MIN_SAMPLE_P95, MIN_SAMPLE_P95_STABLE

        if not self.count:
            return {"available": False, "reason": "milestone_not_captured", "count": 0,
                    "method": "ddsketch", "exact": False, "relative_error": RELATIVE_ERROR,
                    "p50": None, "p90": None, "p95": None, "p99": None, "max": None, "min": None,
                    "mean": None, "p50_confident": False, "p95_confident": False, "p95_stable": False}
        return {
            "available": True, "reason": None, "count": self.count,
            "method": "ddsketch", "exact": False, "relative_error": RELATIVE_ERROR,
            "p50": round(self.quantile(0.5)), "p90": round(self.quantile(0.9)),
            "p95": round(self.quantile(0.95)), "p99": round(self.quantile(0.99)),
            "max": round(self.maximum) if self.maximum is not None else None,
            "min": round(self.minimum) if self.minimum is not None else None,
            "mean": round(self.total / self.count),
            "p50_confident": self.count >= MIN_SAMPLE_P50,
            "p95_confident": self.count >= MIN_SAMPLE_P95,
            "p95_stable": self.count >= MIN_SAMPLE_P95_STABLE,
        }
