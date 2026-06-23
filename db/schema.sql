CREATE DATABASE IF NOT EXISTS kppu_game
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE kppu_game;

CREATE TABLE IF NOT EXISTS rooms (
  code        VARCHAR(6)   NOT NULL PRIMARY KEY,
  host_name   VARCHAR(20)  NOT NULL,
  phase       VARCHAR(20)  NOT NULL DEFAULT 'lobby',
  round       TINYINT      NOT NULL DEFAULT 0,
  state_json  MEDIUMTEXT   NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS room_players (
  room_code   VARCHAR(6)   NOT NULL,
  player_id   VARCHAR(64)  NOT NULL,
  name        VARCHAR(20)  NOT NULL,
  money       INT          NOT NULL DEFAULT 0,
  joined_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_code, player_id),
  FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_log (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_code   VARCHAR(6)    NOT NULL,
  round       TINYINT       NOT NULL,
  player_id   VARCHAR(64)   NOT NULL,
  player_name VARCHAR(20)   NOT NULL,
  produced    INT           NOT NULL DEFAULT 0,
  offer       INT           NOT NULL DEFAULT 0,
  sold        INT           NOT NULL DEFAULT 0,
  profit      INT           NOT NULL DEFAULT 0,
  logged_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
);
