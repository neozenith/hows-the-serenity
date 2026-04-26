"""Pure-Python MVT tile generation.

Output layout matches Deck.GL MVTLayer's URL template `{z}/{x}/{y}.pbf`:

    <out_dir>/<layer_name>/{z}/{x}/{y}.pbf

Each .pbf is a gzipped Mapbox Vector Tile protobuf. Generation pipeline:

    GeoDataFrame (EPSG:4326)
      -> reproject to EPSG:3857 (Web Mercator — MVT's native projection)
      -> for each (z, x, y) covering the data bbox at that zoom:
           clip features to tile bounds (3857)
           encode as MVT with quantize_bounds = tile bounds
           gzip + write
"""

from etl.tiling.coords import tiles_covering_bbox
from etl.tiling.encode import encode_tile
from etl.tiling.writer import write_tile

__all__ = ["encode_tile", "tiles_covering_bbox", "write_tile"]
