from fastapi import APIRouter, HTTPException

from ..services.doc_parser import fetch_extension_readme


router = APIRouter(prefix="/extensions", tags=["extensions"])


@router.get("/{extension_id}/docs")
def extension_docs(extension_id: str):
    result = fetch_extension_readme(extension_id)
    if not result["raw_markdown"]:
        raise HTTPException(
            status_code=404,
            detail="README documentation was not found for this extension.",
        )
    return result
