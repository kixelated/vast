# Report an incident

Click **Report incident** beside the viewer controls, or press **R** while not typing.
The next overlay render captures the current camera without pausing the stream or changing
AI subscriptions. A non-modal panel shows the capture. Optionally select an issue and add a
note, then **Download report**. Nothing is uploaded. Discard closes the local report.

The ZIP contains `incident.json`, `detections.json`, `events.json`, `README.txt`, available
`frame.png` / `overlay.png`, `training-candidate.json`, and SHA-256 hashes when the browser supports Web Crypto.
Boxes are in detection coordinates. Video and overlay dimensions are recorded independently;
no calibrated mapping is asserted. Layer toggles and AI-off are preserved. History is bounded.

This is a snapshot, **not a recording**: the viewer has no rewindable video buffer. The renderer
timestamp's units follow the existing viewer's millisecond assumption, which has not been
independently validated against the player. Its difference from a detection timestamp is
alignment information, not end-to-end latency. Canvas readback may fail or yield a player
surface whose content cannot be verified; metadata still exports, and missing images are
explicit. Report data and predictions are not human-reviewed training labels.

Weave correlation and a Breakpoint importer are not implemented by this change. No Open in
Breakpoint button is shown. Events have unavailable trace metadata, not fabricated
references. Portable reports can be inspected without either product.

No worker, detector, gating, model weights, event decisions, stream protocol or default launch
command is changed. Capture has browser-side copying/encoding cost only when requested.
No video/history recorder or new network subscription is introduced. Relay URLs and query
strings are not serialized. Camera names, event summaries, images and user notes are report
content: review them before sharing the downloaded archive.

## Checks

`node --test tests/incident.test.mjs`

For a synthetic browser check, serve the repository with a local static server and open
`tests/incident-browser.html`. It exercises real canvas encoding and download without starting
camera/model work. It does not establish live moq-watch pixel or timestamp correctness.

## Preparing useful YOLO training data

Each archive includes `training-candidate.json`. It is an annotation queue record, **not a
trainable YOLO example**. It points only to clean `frame.png`, includes its encoded-image
SHA-256 when available, image dimensions, camera/report/viewer-session identity, selection
reason, and explicitly unknown source recording/model configuration. It defaults to
`eligible_for_training: false`, `reviewed_boxes: null`, and `confirmed_background: false`.
No YOLO label file, dataset split or class IDs are guessed from the current model.

Before accepting a candidate:

1. Verify the clean image depicts the intended scene and is neither blank nor an overlay.
2. Assign a versioned target-class schema and annotate **every object of those classes** in
   the clean frame, including ones the detector missed. Do not label just the reported object.
   Predictions can assist review but remain separate. Their detection coordinates cannot be
   copied onto the image until the coordinate mapping is verified, or boxes are redrawn on it.
3. Mark genuinely empty frames as reviewed background explicitly. An unreviewed frame or zero
   model boxes must never silently become a negative training example.
4. Establish source-recording identity, permitted training use and train/validation/test groups.
   Viewer sessions are only provisional provenance: the same looping recording can appear in
   many sessions. Group by original recording/scene/session as appropriate; deduplicate exact
   images by hash and near-duplicates/adjacent frames before splitting.
5. Add representative ordinary scenes, small/distant objects, lighting/weather variation,
   occlusion and reviewed hard negatives. User-reported failures alone are a biased sample.

A separate reviewed-dataset exporter should convert accepted clean-frame pixel boxes into
zero-indexed class IDs and normalized `class x_center y_center width height`, using the CLEAN
IMAGE width and height, and create a dataset class mapping and split manifests. See the
[Ultralytics dataset specification](https://docs.ultralytics.com/datasets/detect/).
No exporter, annotation editor or training run is included here.

Evaluate improvements on untouched, human-reviewed recordings. Measure small-object recall,
false positives and box continuity as well as the live pipeline's latency and inference savings.
An overlay synchronization or gating failure is not automatically a detector-training problem.
The report preserves those distinctions but does not prove which cause applies.

Local review fixes also separate result availability from selection reason, omit overlays without a current result, preserve drafts on recapture, label preview dimensions, and provide capture status/focus handling. Live player validation remains outstanding.
