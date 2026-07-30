import asyncio
from pkg import tool as imported_tool
from pkg.models import DEFAULT_LIMIT, Item


class Service:
    @classmethod
    def build(cls, prefix: str = 'svc') -> 'Service':
        return cls(prefix)

    def __init__(self, prefix: str):
        self.prefix = prefix

    async def stream_items(self, items: list[Item], limit: int = DEFAULT_LIMIT):
        if not items:
            raise ValueError('items required')
        try:
            for item in items:
                yield self.decorate(item.name)
        except RuntimeError as error:
            imported_tool(error)
            raise

    def decorate(self, name: str, suffix: str = '!') -> str:
        helper(name)
        return f'{self.prefix}{name}{suffix}'


@audited('reports')
def summarize(records: list[dict[str, str]], enabled: bool = True) -> list[str]:
    if not enabled:
        return []
    return [normalize(record['name']) for record in records]
