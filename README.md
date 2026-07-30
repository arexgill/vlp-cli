# VLP CLI

VLP CLI is a workspace foundation for the phase 1 product.

## Status

This repository currently contains the monorepo scaffold, package metadata, CI, and workspace checks. Product behavior comes in later phases.

## Phase 1 FastAPI runtime guidance

Phase 1 only supports explicit FastAPI app objects in the runtime config:

```json
{
  "runtime": {
    "type": "fastapi",
    "app": "src.api:app"
  }
}
```

Use a module-level `app` object. Application factories such as `create_app()` are not supported in Phase 1, and the runtime collector does not use `uvicorn --factory`.
