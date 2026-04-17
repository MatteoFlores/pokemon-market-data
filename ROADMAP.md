# Pokemon Market Data

## Summary
Pokemon Market Data is a comprehensive data collection and analysis system that scrapes Pokemon trading card prices and sales data from eBay and TCGPlayer. It uses web scraping, image processing, and machine learning to extract card information, grading certificates, and market pricing trends across multiple Pokemon card sets spanning from Base Set to recent releases.

## Session Summary
The project has established a robust data pipeline with working scrapers for eBay sold listings and TCGPlayer data, implemented YOLOv11-based image detection for PSA grading certificates, and accumulated extensive historical pricing snapshots and sold listing data across 150+ Pokemon card sets. Current focus appears to be on improving certificate extraction accuracy and expanding historical data coverage.

## Features Registry
- eBay sold listings scraper with set-based organization (base1 through me3 sets)
- TCGPlayer CSV data fetching and card mapping system
- Image download pipeline for eBay listings with progress tracking
- YOLOv11 model training for PSA grading certificate detection with validation dataset
- Certificate extraction and OCR pipeline with success/failure categorization
- Price snapshot collection system with historical tracking (2026-04-11 onwards)
- Data persistence layer with JSON caching for eBay tokens and card mappings
- Unmatched sets tracking and error handling across scraping operations

## Completed
- [x] eBay sold listings scraper with set-based organization (base1 through me3 sets)
- [x] TCGPlayer CSV data fetching and card mapping system
- [x] Image download pipeline for eBay listings with progress tracking
- [x] YOLOv11 model training for PSA grading certificate detection with validation dataset
- [x] Certificate extraction and OCR pipeline with success/failure categorization
- [x] Price snapshot collection system with historical tracking (2026-04-11 onwards)
- [x] Data persistence layer with JSON caching for eBay tokens and card mappings
- [x] Unmatched sets tracking and error handling across scraping operations

## In Progress
- [ ] Certificate OCR accuracy improvement and digit extraction refinement
- [ ] PSA grading label detection model evaluation and hyperparameter tuning
- [ ] Expansion of cert_results categorization (ocr_success, verify_later, unextractable)

## To Do
- [ ] Implement automated price trend analysis and anomaly detection across sets
- [ ] Build market analytics dashboard for price tracking and grade correlation
- [ ] Develop API endpoint for real-time price queries and historical comparisons
- [ ] Integrate additional grading body detection (BGS, CGC) beyond PSA certificates
- [ ] Create data export functionality for CSV/JSON reporting with filtering options
- [ ] Implement automated retraining pipeline for certificate detection model with new data
- [ ] Add comparator matching system to link individual cards across different seller listings
- [ ] Build notification system for price drops and market anomalies