from fastapi import APIRouter, Depends, FastAPI
from typing import List

app = FastAPI()
router_a = APIRouter(prefix='/a')
router_b = APIRouter(prefix='/b')

router_a.include_router(router_b, prefix='/to_b')
router_b.include_router(router_a, prefix='/to_a')
app.include_router(router_a, prefix='/root')


class Item:
    pass


def load_user():
    return 'user'


@router_b.api_route(
    '/items/{item_id}',
    methods=['GET', 'POST'],
    status_code=201,
    response_model=Item,
    dependencies=[Depends(load_user)],
)
async def read_item(item_id: int, item: Item, items: List[Item], q: str = None):
    """Read an item"""
    return item
