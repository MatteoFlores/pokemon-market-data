# Pokemon Market Data

## Summary
Pokemon Market Data is a comprehensive web scraping and data analysis system that collects Pokemon trading card pricing information from eBay and TCGPlayer. The project aggregates sold listings, images, price snapshots, and grading certificates to build a detailed market database for Pokemon card valuations and trend analysis.

## Session Summary
The project has a mature data pipeline with extensive historical eBay sold listing data (dating back to 2026 with hundreds of set folders), active image downloads across thousands of listings, and recently implemented computer vision capabilities for certificate extraction and grading label detection using YOLOv11.

## Completed
- [x] eBay sold listings scraper with data persisted across multiple Pokemon card sets (base1-me3 and beyond)
- [x] Image downloading and caching system for eBay listings with progress tracking
- [x] TCGPlayer CSV data integration with set/card mapping
- [x] Price snapshot collection system with historical tracking
- [x] YOLOv11 model training for grading label detection with formal evaluation metrics
- [x] Certificate number extraction pipeline with OCR and classification (ocr_success/unextractable/verify_later states)
- [x] eBay token caching and session management for API access

## In Progress
- [ ] Certificate result verification and refinement (cert_extracted folder with ongoing validation)
- [ ] Fine-tuning grading label detection model accuracy and OCR confidence scoring
- [ ] Dashboard development for market trend visualization (dashboard.js exists)

## To Do
- [ ] Implement automated eBay API listings scraper (fetch_ebay.js partial implementation)
- [ ] Build real-time price monitoring and alert system for significant market movements
- [ ] Create data export pipeline for various formats (CSV, JSON, analytics-ready datasets)
- [ ] Develop web UI dashboard for visualizing price trends, market analytics, and card valuations
- [ ] Implement machine learning model for price prediction based on historical data and card attributes
- [ ] Add support for additional card marketplaces (StockX, PSA Grading direct feeds, Cardmarket)
- [ ] Build data quality validation and anomaly detection for scraped listings
- [ ] Create scheduled job orchestration for continuous data collection and updates