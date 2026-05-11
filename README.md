# hows-the-serenity

Vibe coding the next iteration of the `new-lease-on-life` project.

Alternative project titles considered:

- `its-the-vibe-of-the-thing`
- `tell-em-theyre-dreamin`
- `straight-to-the-pool-room`
- `what-do-you-know-about-lead`
- `bonnie-doon`

## Requirements

- Python 3.12 or higher
- MapBox API key
- Google Maps API Key
- `uv` installed (for dependency management)

## License

[MIT License](LICENSE)

## Acknowledgements

This project uses the API for isochrone calculation.

- [MapBox Isochrone](https://docs.mapbox.com/api/navigation/isochrone/)

It also makes use of Google Directions API as well as Geocoding addresses.

- [Google Maps Directions API (Legacy)](https://developers.google.com/maps/documentation/directions)

Thanks to Victoria Government:

- [Public Transport Lines and Stops (GeoJSON)](https://discover.data.vic.gov.au/dataset/public-transport-lines-and-stops)
- Median Rental Data
    - [Quarterly Median Rent by LGA](https://discover.data.vic.gov.au/dataset/rental-report-quarterly-quarterly-median-rents-by-lga)
    - [Quarterly Annual-Moving-Median Rent by Suburb](https://discover.data.vic.gov.au/dataset/rental-report-quarterly-moving-annual-rents-by-suburb)
- Median Sales Data
    - [Median Annual Sales by Suburb - House](https://discover.data.vic.gov.au/dataset/victorian-property-sales-report-median-house-by-suburb-time-series)
    - [Median Annual Sales by Suburb - Unit](https://discover.data.vic.gov.au/dataset/victorian-property-sales-report-median-unit-by-suburb-time-series)
    - [Median Annual Sales by Suburb - Vacant Land](https://discover.data.vic.gov.au/dataset/victorian-property-sales-report-median-vacant-land-by-suburb-time-series)

Thanks to Australian Bureau of Statistics and their "Non-ABS Structures":

- ["Suburbs and Localities (SAL)" Polygon Boundaries (SHP Files)](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3/jul2021-jun2026/access-and-downloads/digital-boundary-files)
- [LGA Polygon Boundaries (SHP Files)](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3/jul2021-jun2026/access-and-downloads/digital-boundary-files)
- ["Postal Areas (POA)" Polygon Boundaries (SHP Files)](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3/jul2021-jun2026/access-and-downloads/digital-boundary-files)

Also thanks to GeoPandas for the easy assist manipulating all of these geospatial files

- [GeoPandas](https://geopandas.org/en/stable/)

